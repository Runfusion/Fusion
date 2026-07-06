import { createReadStream } from "node:fs";
import { join, resolve, sep } from "node:path";
import type {
  TaskStore,
  Task,
  TaskDetail,
  TaskSource,
  Column,
  TaskReviewData,
  TaskReviewItem,
  TaskReviewSummary,
  GithubIssueAction,
  DuplicateCandidate,
  DuplicateMatch,
  RunAuditEvent,
  ArtifactType,
  PrInfo,
} from "@fusion/core";
import {
  COLUMNS,
  THINKING_LEVELS,
  TASK_PRIORITIES,
  VALID_TRANSITIONS,
  computeContentFingerprint,
  isColumn,
  isTaskPriority,
  REPO_OVERRIDE_RE,
  resolveTitleSummarizerSettingsModel,
  validateNodeOverrideChange,
  canAgentTakeImplementationTaskForExplicitRouting,
  applyWorkflowSettingsOverlay,
  resolveEffectiveSettingsDetailed,
  formatRoleMismatchReason,
  getCurrentRepo,
  findDuplicateMatches,
  deterministicGuardLocks,
  runDeterministicDuplicateGuard,
  buildAutoPauseClearPatch,
  buildManualRetryResetPatch,
  reconcileDeterministicDuplicate,
  extractIntentSignature,
  findNearDuplicates,
  isEphemeralAgent,
  parseExplicitDuplicateMarker,
  isWorkflowColumnsEnabled,
  TransitionRejectionError,
  getPlannerInterventionTimeline,
  isBuiltinWorkflowId,
  type NearDuplicateCandidate,
} from "@fusion/core";
import { GitHubClient } from "../github.js";
import { githubRateLimiter } from "../github-poll.js";
import { createTrackingIssueForTask } from "../github-tracking-hook.js";
import { parseGitHubBadgeUrl } from "./register-git-github.js";
import {
  planTaskWorktreePath,
  promoteHeldTask,
  performTaskRevert,
  revertWorkspaceTask,
  TaskRevertError,
  createAiUndoTask,
  prepareRevertPrBranch,
  prepareWorkspaceRevertPrBranches,
  type AiUndoTaskResult,
  type PrepareRevertPrBranchResult,
  type PrepareWorkspaceRevertPrBranchesResult,
  type WorkspaceRepoRevertPrBranch,
} from "@fusion/engine";
import { buildBoardWorkflowsPayload } from "./board-workflows.js";
import { isBackwardMoveBlockedByOpenPr, PR_OPEN_BLOCKS_MOVE_BACK_MESSAGE } from "./register-pull-requests-routes.js";
import { computePlanApprovalFingerprint, isWorkspaceTask, type RunAuditEventInput } from "@fusion/core";
import { ApiError, badRequest, conflict, notFound } from "../api-error.js";
import type { ApiRoutesContext } from "./types.js";
import { deriveAutoTaskBranch, derivePerTaskBranch, getBranchSelectionMode, resolveBranchSelection } from "./branch-selection.js";

const REVIEW_BLOCK_RE = /##\s+(Code|Plan)\s+Review:[\s\S]*?(?=\n##\s+(?:Code|Plan)\s+Review:|$)/gi;
const REVIEW_VERDICT_RE = /###\s+Verdict:\s*(APPROVE|REVISE|RETHINK|UNAVAILABLE)\b/i;
const REVIEW_STEP_RE = /^(plan|code) review Step (\d+): (APPROVE|REVISE|RETHINK|UNAVAILABLE)\b/i;
const DUPLICATE_STOPWORDS = new Set(["a", "an", "the", "and", "or", "of", "to", "for", "in", "is", "on", "with", "fn"]);
const ARTIFACT_TYPES = new Set<ArtifactType>(["document", "image", "video", "audio", "other"]);
const ADDRESS_PR_FEEDBACK_PROMPT = "Run /ce-resolve-pr-feedback to resolve open PR review feedback: evaluate each thread, fix valid issues, and reply.";

function clearRebuiltSpecWorkflowPins(store: TaskStore, taskId: string): void {
  /*
  FNXC:WorkflowReplan 2026-06-29-00:33:
  Spec rebuild intentionally invalidates the planned step source, so persisted graph foreach pins from the previous PROMPT.md must be cleared before the next parse-steps node runs. Keeping the stale pins makes rebuilt tasks fail closed with pin-mismatch at parse instead of executing the fresh plan.

  FNXC:WorkflowReset 2026-06-29-10:02:
  User reset/retry is also a hard graph-run boundary. Clear all persisted foreach step-instance rows for the task, not only rows outside a keep-run id, because stale rows can be written by an old aborting graph after the first cleanup and then make the next parse fail immediately.
  */
  const maybeStore = store as unknown as {
    clearWorkflowRunStepInstances?: (taskId: string) => void;
  };
  try {
    maybeStore.clearWorkflowRunStepInstances?.(taskId);
  } catch {
    // Legacy stores may not have workflow-run instance persistence; rebuild must still proceed.
  }
}

function isArtifactType(value: string): value is ArtifactType {
  return ARTIFACT_TYPES.has(value as ArtifactType);
}

function resolveArtifactMediaPath(scopedStore: TaskStore, artifact: { taskId?: string; uri?: string }): string | null {
  if (!artifact.uri) {
    return null;
  }

  const anchorDir = artifact.taskId ? scopedStore.getTaskDir(artifact.taskId) : scopedStore.getFusionDir();
  const expectedArtifactsDir = resolve(anchorDir, "artifacts");
  const mediaPath = resolve(anchorDir, artifact.uri);
  if (mediaPath !== expectedArtifactsDir && !mediaPath.startsWith(`${expectedArtifactsDir}${sep}`)) {
    throw badRequest("Invalid artifact media path");
  }
  return mediaPath;
}

interface AutoSyncOutcome {
  worktreePath: string | null;
  outcome: string;
  mode: string;
  stashedFiles?: string[];
  untrackedRestored?: string[];
  untrackedSkippedAsTracked?: string[];
  conflictedFiles?: string[];
  patchPath?: string;
  stage?: string;
  error?: string;
}

interface MergeAdvanceEvent {
  taskId: string;
  integrationBranch: string;
  refName: string;
  toSha: string;
  fromSha: string | null;
  advanceMode: "fast-forward" | "non-fast-forward" | "update-ref" | string;
  succeeded: boolean;
  advancedAt: string;
  userCheckout: {
    worktreePath: string;
    dirty: boolean;
    untrackedCount: number;
  } | null;
  /** Per-worktree outcomes of the merger's post-advance auto-sync hook. Empty
   *  array when `mergeAdvanceAutoSync: "off"` or no other worktree was on the
   *  integration branch. A `synced-with-pop-conflict` entry carries
   *  `patchPath` pointing at the user's saved edits and `conflictedFiles` /
   *  `untrackedSkippedAsTracked` for surfacing in the conflict modal. */
  autoSync: AutoSyncOutcome[];
}

interface MergeAdvanceEventsResponse {
  events: MergeAdvanceEvent[];
}

type PushDisabledReason = "no-remote" | "no-upstream" | "not-ahead" | "merge-locked" | "not-a-git-repo";

interface PushOriginStatus {
  integrationBranch: string;
  branchSource: "settings" | "origin-head" | "fallback";
  hasOriginRemote: boolean;
  hasUpstream: boolean;
  localSha: string | null;
  remoteSha: string | null;
  aheadCount: number;
  behindCount: number;
  mergeActive: boolean;
  canPush: boolean;
  disabledReason?: PushDisabledReason;
}

function parseRevListCounts(raw: string): { behindCount: number; aheadCount: number } {
  const [behindRaw, aheadRaw] = raw.trim().split(/\s+/);
  const behindCount = Number.parseInt(behindRaw ?? "0", 10);
  const aheadCount = Number.parseInt(aheadRaw ?? "0", 10);
  return {
    behindCount: Number.isFinite(behindCount) ? behindCount : 0,
    aheadCount: Number.isFinite(aheadCount) ? aheadCount : 0,
  };
}

function truncateStderr(stderr: string | undefined, max = 4_096): string | undefined {
  if (!stderr) return undefined;
  return stderr.length <= max ? stderr : stderr.slice(0, max);
}

function parsePushOriginBody(body: unknown): { forceWithLease: boolean; expectedLocalSha?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { forceWithLease: false };
  }
  const candidate = body as { forceWithLease?: unknown; expectedLocalSha?: unknown };
  if (candidate.forceWithLease !== undefined && typeof candidate.forceWithLease !== "boolean") {
    throw badRequest("forceWithLease must be boolean");
  }
  if (candidate.expectedLocalSha !== undefined && typeof candidate.expectedLocalSha !== "string") {
    throw badRequest("expectedLocalSha must be string");
  }
  return {
    forceWithLease: candidate.forceWithLease === true,
    expectedLocalSha: candidate.expectedLocalSha,
  };
}

function parsePushOutcome(stderr: string): { outcome: "rejected-non-ff" | "rejected-other"; message?: string } {
  const lowered = stderr.toLowerCase();
  if (lowered.includes("stale info")) {
    return { outcome: "rejected-non-ff", message: "Remote moved since you previewed — fetch and retry." };
  }
  if (lowered.includes("non-fast-forward") || lowered.includes("fetch first") || lowered.includes("[rejected]")) {
    return { outcome: "rejected-non-ff", message: "Remote diverged — pull or fetch first." };
  }
  return { outcome: "rejected-other" };
}

function parseBranchSourceFromSettings(settings: unknown): "settings" | "fallback" {
  if (!settings || typeof settings !== "object") return "fallback";
  const integrationBranch = (settings as { integrationBranch?: unknown }).integrationBranch;
  const baseBranch = (settings as { baseBranch?: unknown }).baseBranch;
  if (typeof integrationBranch === "string" && integrationBranch.trim().length > 0) return "settings";
  if (typeof baseBranch === "string" && baseBranch.trim().length > 0) return "settings";
  return "fallback";
}

function parseGitErrorStderr(error: unknown): string {
  if (error instanceof Error && typeof (error as Error & { stderr?: unknown }).stderr === "string") {
    return String((error as Error & { stderr?: string }).stderr ?? "");
  }
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}

function parseDisabledOutcome(reason?: PushDisabledReason): "no-upstream" | "no-remote" | "merge-locked" | "not-ahead" | "failed" {
  if (!reason) return "failed";
  if (reason === "no-upstream" || reason === "no-remote" || reason === "merge-locked" || reason === "not-ahead") {
    return reason;
  }
  return "failed";
}

async function buildPushOriginStatus(input: {
  scopedStore: TaskStore;
  runGitCommand: (args: string[], cwd: string, timeoutMs: number) => Promise<string>;
  isGitRepo: (cwd: string) => Promise<boolean>;
  resolveIntegrationBranch: (rootDir: string, settings: unknown) => Promise<string>;
  resolveSelfHealingManager: (scopedStore: TaskStore) => { getActiveMergeTaskId: () => string | null } | undefined;
}): Promise<PushOriginStatus> {
  const rootDir = input.scopedStore.getRootDir();
  const settings = await input.scopedStore.getSettingsFast();
  const integrationBranch = await input.resolveIntegrationBranch(rootDir, settings);
  const baseStatus: PushOriginStatus = {
    integrationBranch,
    branchSource: parseBranchSourceFromSettings(settings),
    hasOriginRemote: false,
    hasUpstream: false,
    localSha: null,
    remoteSha: null,
    aheadCount: 0,
    behindCount: 0,
    mergeActive: false,
    canPush: false,
  };

  if (!(await input.isGitRepo(rootDir))) {
    return { ...baseStatus, disabledReason: "not-a-git-repo" };
  }

  const selfHealing = input.resolveSelfHealingManager(input.scopedStore);
  const mergeActive = Boolean(selfHealing?.getActiveMergeTaskId?.());

  try {
    await input.runGitCommand(["remote", "get-url", "origin"], rootDir, 15_000);
  } catch {
    return { ...baseStatus, mergeActive, disabledReason: "no-remote" };
  }

  try {
    await input.runGitCommand(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${integrationBranch}`], rootDir, 15_000);
  } catch {
    return { ...baseStatus, hasOriginRemote: true, mergeActive, disabledReason: "no-upstream" };
  }

  const [localSha, remoteSha, counts] = await Promise.all([
    input.runGitCommand(["rev-parse", `refs/heads/${integrationBranch}`], rootDir, 15_000),
    input.runGitCommand(["rev-parse", `refs/remotes/origin/${integrationBranch}`], rootDir, 15_000),
    input.runGitCommand(["rev-list", "--left-right", "--count", `refs/remotes/origin/${integrationBranch}...refs/heads/${integrationBranch}`], rootDir, 15_000),
  ]);
  const { behindCount, aheadCount } = parseRevListCounts(counts);
  const canPush = aheadCount > 0 && !mergeActive;
  const disabledReason = mergeActive ? "merge-locked" : aheadCount > 0 ? undefined : "not-ahead";

  return {
    ...baseStatus,
    hasOriginRemote: true,
    hasUpstream: true,
    localSha: localSha.trim() || null,
    remoteSha: remoteSha.trim() || null,
    behindCount,
    aheadCount,
    mergeActive,
    canPush,
    disabledReason,
  };
}

function parseMergeAdvanceLimit(rawLimit: unknown): number {
  if (rawLimit === undefined) {
    return 20;
  }
  const parsed = Number.parseInt(String(rawLimit), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw badRequest("limit must be a positive integer");
  }
  return Math.min(parsed, 100);
}

function extractUserCheckout(metadata: unknown): MergeAdvanceEvent["userCheckout"] {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const raw = (metadata as { userCheckout?: unknown }).userCheckout;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as { worktreePath?: unknown; dirty?: unknown; untrackedCount?: unknown };
  if (typeof candidate.worktreePath !== "string" || candidate.worktreePath.length === 0) {
    return null;
  }
  return {
    worktreePath: candidate.worktreePath,
    dirty: candidate.dirty === true,
    untrackedCount: typeof candidate.untrackedCount === "number" ? candidate.untrackedCount : 0,
  };
}

function extractAutoSyncOutcome(event: RunAuditEvent): AutoSyncOutcome | null {
  const metadata = event.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const candidate = metadata as {
    worktreePath?: unknown;
    outcome?: unknown;
    mode?: unknown;
    stashedFiles?: unknown;
    untrackedRestored?: unknown;
    untrackedSkippedAsTracked?: unknown;
    conflictedFiles?: unknown;
    patchPath?: unknown;
    stage?: unknown;
    error?: unknown;
  };
  if (typeof candidate.outcome !== "string" || candidate.outcome.length === 0) return null;
  const stringArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
  return {
    worktreePath: typeof candidate.worktreePath === "string" ? candidate.worktreePath : null,
    outcome: candidate.outcome,
    mode: typeof candidate.mode === "string" ? candidate.mode : "stash-and-ff",
    stashedFiles: stringArray(candidate.stashedFiles),
    untrackedRestored: stringArray(candidate.untrackedRestored),
    untrackedSkippedAsTracked: stringArray(candidate.untrackedSkippedAsTracked),
    conflictedFiles: stringArray(candidate.conflictedFiles),
    patchPath: typeof candidate.patchPath === "string" ? candidate.patchPath : undefined,
    stage: typeof candidate.stage === "string" ? candidate.stage : undefined,
    error: typeof candidate.error === "string" ? candidate.error : undefined,
  };
}

function extractMergeAdvanceEvent(event: RunAuditEvent): Omit<MergeAdvanceEvent, "userCheckout" | "autoSync"> | null {
  const metadata = event.metadata;
  if (!metadata || typeof metadata !== "object") {
    console.warn(`[merge-advance-events] dropping run-audit event ${event.id}: missing metadata`);
    return null;
  }
  const candidate = metadata as {
    integrationBranch?: unknown;
    refName?: unknown;
    toSha?: unknown;
    fromSha?: unknown;
    advanceMode?: unknown;
    succeeded?: unknown;
  };
  if (typeof candidate.integrationBranch !== "string" || candidate.integrationBranch.length === 0 || typeof candidate.toSha !== "string" || candidate.toSha.length === 0) {
    console.warn(`[merge-advance-events] dropping run-audit event ${event.id}: missing integrationBranch or toSha`);
    return null;
  }
  if (typeof event.taskId !== "string" || event.taskId.length === 0) {
    console.warn(`[merge-advance-events] dropping run-audit event ${event.id}: missing taskId`);
    return null;
  }
  return {
    taskId: event.taskId,
    integrationBranch: candidate.integrationBranch,
    refName: typeof candidate.refName === "string" ? candidate.refName : `refs/heads/${candidate.integrationBranch}`,
    toSha: candidate.toSha,
    fromSha: typeof candidate.fromSha === "string" ? candidate.fromSha : null,
    advanceMode: typeof candidate.advanceMode === "string" ? candidate.advanceMode : "update-ref",
    succeeded: candidate.succeeded !== false,
    advancedAt: event.timestamp,
  };
}

export const __fingerprintCreateLocksForTests = deterministicGuardLocks;

const RESET_TASK_FIELDS = {
  worktree: null,
  branch: null,
  currentStep: 0,
  status: null,
  error: null,
  stuckKillCount: 0,
  taskDoneRetryCount: null,
  worktreeSessionRetryCount: null,
  workflowStepRetries: undefined,
  recoveryRetryCount: null,
  nextRecoveryAt: null,
  postReviewFixCount: 0,
  verificationFailureCount: 0,
  mergeConflictBounceCount: 0,
  checkedOutBy: null,
  executionStartedAt: null,
  sessionFile: null,
} as const;

const RESET_DRIFT_CORRECTION_FIELDS = {
  column: "todo" as const,
  worktree: null,
  branch: null,
  status: null,
  error: null,
  checkedOutBy: null,
  executionStartedAt: null,
  taskDoneRetryCount: null,
  worktreeSessionRetryCount: null,
  sessionFile: null,
} as const;

async function emitResetDriftAudit(
  scopedStore: TaskStore,
  taskId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const recordRunAuditEvent = (scopedStore as TaskStore & {
    recordRunAuditEvent?: (input: RunAuditEventInput) => Promise<void>;
  }).recordRunAuditEvent;
  if (typeof recordRunAuditEvent !== "function") {
    return;
  }
  await recordRunAuditEvent({
    taskId,
    agentId: "system",
    runId: `synthetic-dashboard-reset-${taskId}-${Date.now()}`,
    domain: "database",
    mutationType: "task:auto-recover-reset-drift",
    target: taskId,
    metadata,
  });
}

async function releaseExecutionAgentBindings(
  engine: { getAgentStore?: () => { listAgents: (input: { includeEphemeral?: boolean }) => Promise<Array<{ id: string; taskId?: string }>>; syncExecutionTaskLink: (agentId: string, taskId: string | undefined) => Promise<unknown>; deleteAgent: (agentId: string) => Promise<unknown>; getAgent?: (agentId: string) => Promise<unknown>; } | undefined } | undefined,
  taskId: string,
): Promise<void> {
  const agentStore = engine?.getAgentStore?.();
  if (!agentStore) {
    return;
  }

  const linkedAgents = (await agentStore.listAgents({ includeEphemeral: true }))
    .filter((agent) => agent.taskId === taskId);

  for (const agent of linkedAgents) {
    if (isEphemeralAgent(agent as never)) {
      await agentStore.deleteAgent(agent.id);
      continue;
    }
    await agentStore.syncExecutionTaskLink(agent.id, undefined);
  }
}

function buildDuplicateQuery(title: string | undefined, description: string): string {
  const tokens = `${title ?? ""} ${description}`
    .toLowerCase()
    .split(/\W+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !DUPLICATE_STOPWORDS.has(token));

  const deduped = [...new Set(tokens)];
  const selected = deduped.sort((left, right) => right.length - left.length).slice(0, 5);
  return selected.join(" ");
}

async function computeDuplicateMatches(
  scopedStore: TaskStore,
  input: { title?: string; description: string; limit?: number; threshold?: number },
): Promise<DuplicateMatch[]> {
  const query = buildDuplicateQuery(input.title, input.description);
  if (query.length === 0) {
    return [];
  }

  const results = await scopedStore.searchTasks(query, {
    slim: true,
    includeArchived: false,
    limit: 20,
  });
  const candidates: DuplicateCandidate[] = results.map((task) => ({
    id: task.id,
    title: task.title ?? "",
    description: task.description ?? "",
    column: task.column,
  }));

  return findDuplicateMatches(
    {
      title: input.title,
      description: input.description,
    },
    candidates,
    {
      threshold: input.threshold,
      limit: input.limit ?? 5,
    },
  );
}

function buildReviewerAgentItemId(input: { index: number; reviewType: "plan" | "code"; step?: number; verdict?: string; createdAt?: string }): string {
  const stepPart = input.step ? `step-${input.step}` : "step-na";
  const verdictPart = (input.verdict ?? "unknown").toLowerCase();
  const timePart = (input.createdAt ?? "na").replace(/[:.]/g, "-");
  return `reviewer-${input.reviewType}-${stepPart}-${verdictPart}-${timePart}-${input.index + 1}`;
}

async function buildDirectTaskReviewData(task: Task, store: TaskStore): Promise<TaskReviewData> {
  const agentLogs = await store.getAgentLogs(task.id);
  const reviewerText = agentLogs.filter((entry) => entry.agent === "reviewer" && entry.type === "text").map((entry) => entry.text).join("\n");
  const fallbackLogs = (task.log ?? []).filter((entry) => REVIEW_STEP_RE.test(entry.action));

  const items: TaskReviewItem[] = [];
  const blocks = reviewerText.match(REVIEW_BLOCK_RE) ?? [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] ?? "";
    const typeMatch = block.match(/##\s+(Code|Plan)\s+Review:/i);
    const reviewType = typeMatch?.[1]?.toLowerCase() === "plan" ? "plan" : "code";
    const verdict = block.match(REVIEW_VERDICT_RE)?.[1]?.toUpperCase();
    const fallback = fallbackLogs[index];
    const createdAt = fallback?.timestamp ?? task.updatedAt;
    items.push({
      itemId: buildReviewerAgentItemId({ index, reviewType, verdict, createdAt }),
      sourceMode: "reviewer-agent",
      title: `${reviewType} review ${verdict ?? "feedback"}`,
      body: block.trim(),
      author: "reviewer-agent",
      createdAt,
      updatedAt: createdAt,
      reviewState: verdict ?? null,
      progressStatus: null,
    });
  }

  if (items.length === 0) {
    fallbackLogs.forEach((entry, index) => {
      const match = entry.action.match(REVIEW_STEP_RE);
      const reviewType = match?.[1]?.toLowerCase() === "plan" ? "plan" : "code";
      const verdict = match?.[3]?.toUpperCase();
      items.push({
        itemId: buildReviewerAgentItemId({ index, reviewType, step: match?.[2] ? Number.parseInt(match[2], 10) : undefined, verdict, createdAt: entry.timestamp }),
        sourceMode: "reviewer-agent",
        title: `${reviewType} review ${verdict ?? "feedback"}`,
        body: entry.action,
        author: "reviewer-agent",
        createdAt: entry.timestamp,
        updatedAt: entry.timestamp,
        reviewState: verdict ?? null,
        progressStatus: null,
      });
    });
  }

  const sorted = [...items].sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
  const latest = sorted[0];
  const summary: TaskReviewSummary | null = latest
    ? {
        summary: latest.title,
        verdict: (latest.reviewState as "APPROVE" | "REVISE" | "RETHINK" | "UNAVAILABLE" | null | undefined) ?? undefined,
      }
    : null;

  return {
    mode: "reviewer-agent",
    refreshable: true,
    fetchedAt: new Date().toISOString(),
    summary,
    items: sorted,
  };
}

interface TaskWorkflowRouteDeps {
  runtimeLogger: { error: (message: string, data?: Record<string, unknown>) => void; warn: (message: string, data?: Record<string, unknown>) => void };
  upload: { single: (name: string) => unknown };
  taskDetailActivityLogLimit: number;
  validateOptionalModelField: (value: unknown, name: string) => string | undefined;
  normalizeModelSelectionPair: (provider: string | undefined, modelId: string | undefined) => { provider?: string | null; modelId?: string | null };
  runGitCommand: (args: string[], cwd: string, timeoutMs: number) => Promise<string>;
  isGitRepo: (cwd: string) => Promise<boolean>;
  resolveIntegrationBranch: (rootDir: string, settings: unknown) => Promise<string>;
  trimTaskDetailActivityLog: (task: TaskDetail) => TaskDetail;
  triggerCommentWakeForAssignedAgent: (scopedStore: TaskStore, task: Task, wake: { triggeringCommentType: "steering" | "task" | "pr"; triggeringCommentIds?: string[]; triggerDetail: string }) => Promise<void>;
  resolveSelfHealingManager: (scopedStore: TaskStore) => {
    rootDir: string;
    reconcileInReviewBranchRebind: (opts?: { includeTaskIds?: Set<string> }) => Promise<import("@fusion/engine").RebindResult>;
    getActiveMergeTaskId: () => string | null;
  } | undefined;
}

export function registerTaskWorkflowRoutes(ctx: ApiRoutesContext, deps: TaskWorkflowRouteDeps): void {
  const { router, options, getProjectContext, rethrowAsApiError } = ctx;
  const {
    runtimeLogger,
    upload,
    taskDetailActivityLogLimit,
    validateOptionalModelField,
    normalizeModelSelectionPair,
    runGitCommand,
    isGitRepo,
    resolveIntegrationBranch,
    trimTaskDetailActivityLog,
    triggerCommentWakeForAssignedAgent,
    resolveSelfHealingManager: _resolveSelfHealingManager,
  } = deps;
  const TASK_DETAIL_ACTIVITY_LOG_LIMIT = taskDetailActivityLogLimit;

  type InReviewUserCommentReengagementInput = {
    triggeringCommentType: "steering" | "task";
    triggeringCommentIds?: string[];
    triggerDetail: string;
  };

  type InReviewUserCommentReengagementResult = {
    task: Task;
    reengaged: boolean;
    suppressedReason?: "blocking-pr" | "live-session" | "not-in-review";
  };

  /**
   * FNXC:InReviewChat 2026-06-28-00:00:
   * User-authored Chat steering comments and Comments-tab task comments on an in-review task are explicit instructions to re-engage an executor, even when autoMerge is false. Reuse the review-address lifecycle path so the agent can respond/work and later hand the task back to review; suppress only when an open PR entity blocks the backward in-review → in-progress move.
   * Non-user task-comment authors are persisted without re-engagement so agent/system/API notes cannot bounce review work back to execution.
   */
  async function reengageInReviewTaskForUserComment(
    scopedStore: TaskStore,
    task: Task,
    wake: InReviewUserCommentReengagementInput,
  ): Promise<InReviewUserCommentReengagementResult> {
    if (task.column !== "in-review") {
      return { task, reengaged: false, suppressedReason: "not-in-review" };
    }
    if (task.sessionFile) {
      return { task, reengaged: false, suppressedReason: "live-session" };
    }

    const activePrEntity =
      scopedStore.getActivePrEntityBySource?.("task", task.id) ??
      (task.branchContext?.groupId
        ? scopedStore.getActivePrEntityBySource?.("branch-group", task.branchContext.groupId)
        : null);
    if (
      isBackwardMoveBlockedByOpenPr({
        fromIndex: COLUMNS.indexOf(task.column as Column),
        toIndex: COLUMNS.indexOf("in-progress"),
        activePrEntity,
      })
    ) {
      await scopedStore.logEntry(
        task.id,
        "In-review user comment re-engagement suppressed",
        PR_OPEN_BLOCKS_MOVE_BACK_MESSAGE,
      );
      return { task, reengaged: false, suppressedReason: "blocking-pr" };
    }

    await scopedStore.updateTask(task.id, {
      status: null,
      error: null,
      sessionFile: null,
    });
    const lastDoneStep = [...(task.steps ?? [])]
      .map((step, index) => ({ step, index }))
      .reverse()
      .find(({ step }) => step.status === "done" || step.status === "in-progress");
    if (lastDoneStep) {
      await scopedStore.updateStep(task.id, lastDoneStep.index, "pending");
    }

    const reengagedTask = await scopedStore.moveTask(task.id, "in-progress", { preserveProgress: true });
    await triggerCommentWakeForAssignedAgent(scopedStore, reengagedTask, wake);
    return { task: reengagedTask, reengaged: true };
  }

  // Get recent integration-branch advance events for post-merge notice
  router.get("/tasks/merge-advance-events", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const limit = parseMergeAdvanceLimit(req.query.limit);
      const storeWithRunAudit = scopedStore as TaskStore & {
        getRunAuditEvents?: (filters: {
          taskId?: string;
          domain?: "database" | "git" | "filesystem" | "sandbox";
          mutationType?: string;
          limit?: number;
        }) => RunAuditEvent[];
      };
      if (typeof storeWithRunAudit.getRunAuditEvents !== "function") {
        throw notFound("run-audit unavailable");
      }

      const advanceEvents = storeWithRunAudit.getRunAuditEvents({
        domain: "git",
        mutationType: "merge:integration-ref-advance",
        limit,
      });

      const events: MergeAdvanceEvent[] = [];
      for (const advanceEvent of advanceEvents) {
        const extracted = extractMergeAdvanceEvent(advanceEvent);
        if (!extracted) {
          continue;
        }

        let userCheckout: MergeAdvanceEvent["userCheckout"] = null;
        const stateEvents = storeWithRunAudit.getRunAuditEvents({
          taskId: extracted.taskId,
          domain: "git",
          mutationType: "merge:integration-worktree-state",
          limit,
        });
        const matchingState = stateEvents.find((stateEvent) => stateEvent.timestamp <= advanceEvent.timestamp);
        if (matchingState) {
          userCheckout = extractUserCheckout(matchingState.metadata);
        }

        // Join in any per-worktree auto-sync outcomes for this task. We keep
        // events whose timestamp falls in a small window around the advance
        // so a `synced-with-pop-conflict` (carrying patchPath) surfaces to
        // the dashboard banner even when the sync ran slightly after the
        // advance event was recorded.
        const autoSyncEvents = storeWithRunAudit.getRunAuditEvents({
          taskId: extracted.taskId,
          domain: "git",
          mutationType: "merge:auto-sync",
          limit,
        });
        const advanceMs = Date.parse(advanceEvent.timestamp);
        const AUTO_SYNC_WINDOW_MS = 5 * 60 * 1000;
        const autoSync: AutoSyncOutcome[] = [];
        for (const ev of autoSyncEvents) {
          const evMs = Date.parse(ev.timestamp);
          if (Math.abs(evMs - advanceMs) > AUTO_SYNC_WINDOW_MS) continue;
          const outcome = extractAutoSyncOutcome(ev);
          if (outcome) autoSync.push(outcome);
        }

        events.push({
          ...extracted,
          userCheckout,
          autoSync,
        });
      }

      const response: MergeAdvanceEventsResponse = {
        events: events.sort((a, b) => Date.parse(b.advancedAt) - Date.parse(a.advancedAt)),
      };
      res.json(response);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.get("/projects/:projectId/merge-advance/push-status", async (req, res) => {
    const { store: scopedStore } = await getProjectContext(req);
    const status = await buildPushOriginStatus({
      scopedStore,
      runGitCommand,
      isGitRepo,
      resolveIntegrationBranch,
      resolveSelfHealingManager: _resolveSelfHealingManager,
    });
    res.json(status);
  });

  router.post("/projects/:projectId/merge-advance/push-origin", async (req, res) => {
    const startedAt = Date.now();
    const { store: scopedStore } = await getProjectContext(req);
    const body = parsePushOriginBody(req.body);
    const status = await buildPushOriginStatus({
      scopedStore,
      runGitCommand,
      isGitRepo,
      resolveIntegrationBranch,
      resolveSelfHealingManager: _resolveSelfHealingManager,
    });

    const recordRunAuditEvent = (scopedStore as TaskStore & { recordRunAuditEvent?: (input: RunAuditEventInput) => Promise<void> }).recordRunAuditEvent;
    const emit = async (outcome: string, extra?: Record<string, unknown>) => {
      if (typeof recordRunAuditEvent !== "function") return;
      await recordRunAuditEvent({
        domain: "git",
        mutationType: "push:origin",
        target: `origin/${status.integrationBranch}`,
        taskId: "FN-5359",
        agentId: "user",
        runId: `dashboard-push-origin-${Date.now()}`,
        metadata: {
          integrationBranch: status.integrationBranch,
          remote: "origin",
          localSha: status.localSha,
          remoteSha: status.remoteSha,
          aheadCount: status.aheadCount,
          behindCount: status.behindCount,
          forceWithLease: body.forceWithLease,
          outcome,
          durationMs: Date.now() - startedAt,
          ...extra,
        },
      });
    };

    if (!status.canPush) {
      const outcome = parseDisabledOutcome(status.disabledReason);
      await emit(outcome);
      return res.json({ ok: false, outcome, integrationBranch: status.integrationBranch, aheadCount: status.aheadCount, localSha: status.localSha, remoteSha: status.remoteSha, forceWithLease: body.forceWithLease });
    }

    if (body.expectedLocalSha && body.expectedLocalSha !== status.localSha) {
      await emit("failed", { outcome: "sha-mismatch" });
      return res.json({ ok: false, outcome: "sha-mismatch", integrationBranch: status.integrationBranch, aheadCount: status.aheadCount, localSha: status.localSha, remoteSha: status.remoteSha, forceWithLease: body.forceWithLease });
    }

    const mergeCheck = _resolveSelfHealingManager(scopedStore);
    if (mergeCheck?.getActiveMergeTaskId()) {
      await emit("merge-locked");
      return res.json({ ok: false, outcome: "merge-locked", integrationBranch: status.integrationBranch, aheadCount: status.aheadCount, localSha: status.localSha, remoteSha: status.remoteSha, forceWithLease: body.forceWithLease });
    }

    const refspec = `refs/heads/${status.integrationBranch}:refs/heads/${status.integrationBranch}`;
    const args = ["push", "origin", refspec];
    if (body.forceWithLease && status.localSha) {
      args.splice(1, 0, `--force-with-lease=refs/heads/${status.integrationBranch}:${status.localSha}`);
    }

    try {
      await runGitCommand(args, scopedStore.getRootDir(), 60_000);
      const remoteSha = (await runGitCommand(["rev-parse", `refs/remotes/origin/${status.integrationBranch}`], scopedStore.getRootDir(), 15_000)).trim() || status.remoteSha;
      await emit("ok", { remoteSha });
      return res.json({ ok: true, outcome: "ok", integrationBranch: status.integrationBranch, aheadCount: status.aheadCount, localSha: status.localSha, remoteSha, forceWithLease: body.forceWithLease });
    } catch (error: unknown) {
      const stderr = parseGitErrorStderr(error);
      const parsed = parsePushOutcome(stderr);
      await emit(parsed.outcome, { stderrPreview: truncateStderr(stderr) });
      return res.json({
        ok: false,
        outcome: parsed.outcome,
        message: parsed.message,
        stderrPreview: truncateStderr(stderr),
        integrationBranch: status.integrationBranch,
        aheadCount: status.aheadCount,
        localSha: status.localSha,
        remoteSha: status.remoteSha,
        forceWithLease: body.forceWithLease,
      });
    }
  });

  router.get("/tasks", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
      const offset = typeof req.query.offset === "string" ? Number.parseInt(req.query.offset, 10) : undefined;
      const q = typeof req.query.q === "string" ? req.query.q.trim() : undefined;
      const includeArchived = req.query.includeArchived === "1" || req.query.includeArchived === "true";
      const columnParam = typeof req.query.column === "string" ? req.query.column.trim() : undefined;
      const column = columnParam ? (isColumn(columnParam) ? columnParam : undefined) : undefined;

      if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
        throw badRequest("limit must be a non-negative integer");
      }
      if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
        throw badRequest("offset must be a non-negative integer");
      }
      if (columnParam && !column) {
        throw badRequest(`column must be one of: ${COLUMNS.join(", ")}`);
      }

      let tasks;
      if (q && q.length > 0) {
        tasks = await scopedStore.searchTasks(q, { limit, offset, slim: true, includeArchived });
      } else {
        // Board-view list: omit the heavy agent log payload and exclude
        // archived tasks unless explicitly requested. Full task detail still loads via
        // GET /api/tasks/:id. Without this, every dashboard load shipped tens of MB of agent logs.
        const listOptions = { limit, offset, slim: true, includeArchived, ...(column ? { column } : {}) };
        tasks = await scopedStore.listTasks(listOptions);
      }

      // Residual B (U9/U13): additively populate `branchProgress` when the
      // workflowColumns flag is ON and the fan-out branch table has rows for
      // any of these tasks. One batched query (cheap; short-circuits when the
      // table is empty). The payload is otherwise byte-identical.
      try {
        const settings = await scopedStore.getSettingsFast();
        if (isWorkflowColumnsEnabled(settings) && tasks.length > 0) {
          const byTask = scopedStore.getBranchProgressByTask(tasks.map((t) => t.id));
          if (byTask.size > 0) {
            tasks = tasks.map((task) => {
              const branchProgress = byTask.get(task.id);
              return branchProgress && branchProgress.length > 0
                ? { ...task, branchProgress }
                : task;
            });
          }
        }
      } catch {
        // Branch-progress enrichment is best-effort and must never fail the
        // board load — fall through with the un-enriched task list.
      }

      // FNXC:PlannerOversight 2026-07-04-00:00:
      // FN-7531 additively attaches the transient `plannerOverseerState`
      // snapshot for each task with an active planner-overseer observation,
      // mirroring the `branchProgress` enrichment block directly above: it
      // is best-effort, never fails the board load on any engine error, and
      // omits the field entirely (rather than attaching `null`) for tasks
      // with no active observation — the payload stays byte-identical for
      // those tasks. Consumed by FN-7516's TaskCard badge.
      try {
        if (engine && tasks.length > 0) {
          tasks = tasks.map((task) => {
            const plannerOverseerState = engine.getPlannerOverseerRuntimeSnapshot(task.id);
            return plannerOverseerState ? { ...task, plannerOverseerState } : task;
          });
        }
      } catch {
        // Planner-overseer-state enrichment is best-effort and must never
        // fail the board load — fall through with the un-enriched task list.
      }

      res.json(tasks);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Multi-lane board metadata (U9, R16). Additive sibling to GET /tasks — the
  // task list payload stays byte-identical. Flag-OFF returns
  // { flagEnabled: false } and the client renders the legacy single-lane board.
  router.get("/tasks/board-workflows", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettingsFast();
      if (!isWorkflowColumnsEnabled(settings)) {
        res.json({ flagEnabled: false, defaultWorkflowId: "builtin:coding", workflows: [], taskWorkflowIds: {} });
        return;
      }
      // Resolve over the same (non-archived) board list the client renders.
      const tasks = await scopedStore.listTasks({ slim: true, includeArchived: false });
      const taskIds = tasks.map((t) => t.id);
      const payload = await buildBoardWorkflowsPayload(scopedStore, taskIds, settings);
      res.json(payload);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.post("/tasks/duplicate-check", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { title, description, limit, threshold } = req.body ?? {};

      if (typeof description !== "string" || description.trim().length === 0) {
        throw badRequest("description is required");
      }
      if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) {
        throw badRequest("limit must be a positive integer");
      }
      if (threshold !== undefined && (typeof threshold !== "number" || Number.isNaN(threshold))) {
        throw badRequest("threshold must be a number");
      }

      const matches = await computeDuplicateMatches(scopedStore, {
        title: typeof title === "string" ? title : undefined,
        description: description.trim(),
        limit,
        threshold,
      });

      res.json({ matches });
      return;
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Create task
  router.post("/tasks", async (req, res) => {
    try {
      const { store: scopedStore, projectId } = await getProjectContext(req);
      const {
        title,
        description,
        column,
        dependencies,
        breakIntoSubtasks,
        enabledWorkflowSteps,
        workflowId,
        modelPresetId,
        modelProvider,
        modelId,
        validatorModelProvider,
        validatorModelId,
        planningModelProvider,
        planningModelId,
        thinkingLevel,
        reviewLevel,
        executionMode,
        autoMerge,
        priority,
        source,
        branch,
        baseBranch,
        branchSelection,
        nodeId,
        githubTracking,
        acknowledgedDuplicates,
        bypassDuplicateCheck,
      } = req.body;
      if (!description || typeof description !== "string") {
        throw badRequest("description is required");
      }
      if (
        acknowledgedDuplicates !== undefined
        && (!Array.isArray(acknowledgedDuplicates)
          || !acknowledgedDuplicates.every((taskId: unknown) => typeof taskId === "string" && /^[A-Z]+-\d+$/.test(taskId)))
      ) {
        throw badRequest("acknowledgedDuplicates must be an array of task IDs");
      }
      if (bypassDuplicateCheck !== undefined && typeof bypassDuplicateCheck !== "boolean") {
        throw badRequest("bypassDuplicateCheck must be a boolean");
      }
      if (breakIntoSubtasks !== undefined && typeof breakIntoSubtasks !== "boolean") {
        throw badRequest("breakIntoSubtasks must be a boolean");
      }

      const validatedModelProvider = validateOptionalModelField(modelProvider, "modelProvider");
      const validatedModelId = validateOptionalModelField(modelId, "modelId");
      const validatedValidatorModelProvider = validateOptionalModelField(validatorModelProvider, "validatorModelProvider");
      const validatedValidatorModelId = validateOptionalModelField(validatorModelId, "validatorModelId");
      const validatedPlanningModelProvider = validateOptionalModelField(planningModelProvider, "planningModelProvider");
      const validatedPlanningModelId = validateOptionalModelField(planningModelId, "planningModelId");

      // Validate thinkingLevel if provided
      const validThinkingLevels = [...THINKING_LEVELS];
      if (thinkingLevel !== undefined && thinkingLevel !== null && !validThinkingLevels.includes(thinkingLevel)) {
        throw badRequest(`thinkingLevel must be one of: ${validThinkingLevels.join(", ")}`);
      }

      // Validate reviewLevel if provided (must be integer 0-3)
      if (reviewLevel !== undefined && reviewLevel !== null) {
        if (typeof reviewLevel !== "number" || !Number.isInteger(reviewLevel) || reviewLevel < 0 || reviewLevel > 3) {
          throw badRequest("reviewLevel must be an integer between 0 and 3");
        }
      }

      // Validate executionMode if provided (must be "standard" or "fast")
      const validExecutionModes = ["standard", "fast"];
      if (executionMode !== undefined && executionMode !== null && !validExecutionModes.includes(executionMode)) {
        throw badRequest(`executionMode must be one of: ${validExecutionModes.join(", ")}`);
      }

      if (autoMerge !== undefined && typeof autoMerge !== "boolean") {
        throw badRequest("autoMerge must be a boolean");
      }

      // Validate priority if provided.
      if (priority !== undefined && priority !== null && !isTaskPriority(priority)) {
        throw badRequest(`priority must be one of: ${TASK_PRIORITIES.join(", ")}`);
      }

      if (nodeId !== undefined && nodeId !== null && typeof nodeId !== "string") {
        throw badRequest("nodeId must be a string");
      }

      const executorModel = normalizeModelSelectionPair(validatedModelProvider, validatedModelId);
      const validatorModel = normalizeModelSelectionPair(validatedValidatorModelProvider, validatedValidatorModelId);
      const planningModel = normalizeModelSelectionPair(validatedPlanningModelProvider, validatedPlanningModelId);

      // Validate enabledWorkflowSteps if provided
      if (enabledWorkflowSteps !== undefined) {
        if (!Array.isArray(enabledWorkflowSteps) || !enabledWorkflowSteps.every((id: unknown) => typeof id === "string")) {
          throw badRequest("enabledWorkflowSteps must be an array of strings");
        }
      }

      // Validate workflowId (U6/R3): undefined = inherit default, null = no
      // workflow, string = that workflow. Unknown/fragment ids are rejected by
      // the store below (mapped to 4xx in the catch handler).
      if (workflowId !== undefined && workflowId !== null && typeof workflowId !== "string") {
        throw badRequest("workflowId must be a string or null");
      }

      // Check for summarize flag in request
      const summarize = req.body.summarize === true;

      // Get settings for auto-summarization (fast path — skips expensive workflow steps query)
      const settings = await scopedStore.getSettingsFast();

      // Create onSummarize callback if summarization is enabled
      const onSummarize = (summarize || settings.autoSummarizeTitles)
        ? async (desc: string): Promise<string | null> => {
            try {
              const { summarizeTitle } = await import("@fusion/core");

              // Resolve model selection hierarchy for summarization:
              // 1. Project title summarizer lane
              // 2. Global title summarizer lane
              // 3. Project planning lane
              // 4. Project default override
              // 5. Global default
              const { provider: resolvedProvider, modelId: resolvedModelId } =
                resolveTitleSummarizerSettingsModel(settings);

              return await summarizeTitle(desc, scopedStore.getRootDir(), resolvedProvider, resolvedModelId);
            } catch (err) {
              // Log the full error so server logs show what went wrong
              const errorMessage = err instanceof Error ? err.message : String(err);
              runtimeLogger.error(`Title summarization failed: ${errorMessage}`, {
                error: errorMessage,
              });
              // Return null on error so task creation continues without title
              return null;
            }
          }
        : undefined;

      const normalizedSource =
        source && typeof source === "object" && "sourceType" in source && typeof (source as { sourceType?: unknown }).sourceType === "string"
          ? source
          : { sourceType: "api" as const };

      const requestedBranchMode = getBranchSelectionMode(branchSelection);
      const { branch: normalizedBranch, baseBranch: normalizedBaseBranch, sharedFeatureBranch } =
        resolveBranchSelection(branchSelection, branch, baseBranch);

      let validatedGithubTracking: { enabled?: boolean; repoOverride?: string } | undefined;
      if (githubTracking !== undefined && githubTracking !== null) {
        if (typeof githubTracking !== "object") {
          throw badRequest("githubTracking must be an object");
        }
        const candidate = githubTracking as { enabled?: unknown; repoOverride?: unknown };
        if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") {
          throw badRequest("githubTracking.enabled must be a boolean");
        }
        if (candidate.repoOverride !== undefined && typeof candidate.repoOverride !== "string") {
          throw badRequest("githubTracking.repoOverride must be a string");
        }
        const trimmedRepoOverride = typeof candidate.repoOverride === "string" ? candidate.repoOverride.trim() : "";
        if (trimmedRepoOverride.length > 0 && !REPO_OVERRIDE_RE.test(trimmedRepoOverride)) {
          throw badRequest("githubTracking.repoOverride must be in 'owner/repo' format");
        }
        validatedGithubTracking = {
          ...(candidate.enabled !== undefined ? { enabled: candidate.enabled } : {}),
          ...(trimmedRepoOverride.length > 0 ? { repoOverride: trimmedRepoOverride } : {}),
        };
      }

      const normalizedDescription = description.trim();
      const normalizedTitle = typeof title === "string" ? title : undefined;
      const acknowledgedDuplicateIds = acknowledgedDuplicates ?? [];
      let intentSignature: ReturnType<typeof extractIntentSignature> = {
        routePaths: [],
        filePaths: [],
        identifiers: [],
        titleTokens: [],
      };
      try {
        intentSignature = extractIntentSignature({
          title: normalizedTitle,
          description: normalizedDescription,
        });
      } catch (error) {
        runtimeLogger.warn("Near-duplicate intent guard failed; proceeding", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const contentFingerprintSeed = computeContentFingerprint({
        title: normalizedTitle,
        description: normalizedDescription,
      });
      const preexistingLockKey = contentFingerprintSeed ? `${projectId}:${contentFingerprintSeed}` : null;

      let deterministicGuard: Awaited<ReturnType<typeof runDeterministicDuplicateGuard>>;
      let contentFingerprint: string | null = null;
      if (preexistingLockKey) {
        const preexistingLock = __fingerprintCreateLocksForTests.get(preexistingLockKey);
        if (preexistingLock) {
          await preexistingLock;
        }
      }

      try {
        deterministicGuard = await runDeterministicDuplicateGuard(
          scopedStore,
          {
            title: normalizedTitle,
            description: normalizedDescription,
          },
          {
            lockScope: projectId,
            acknowledgedDuplicates: acknowledgedDuplicateIds,
            bypass: bypassDuplicateCheck === true,
            logger: runtimeLogger,
          },
        );
      } catch (error) {
        runtimeLogger.warn("Deterministic duplicate pre-check failed; proceeding", {
          lockKey: preexistingLockKey,
          contentFingerprint,
          error: error instanceof Error ? error.message : String(error),
        });
        deterministicGuard = {
          action: "proceed",
          fingerprint: contentFingerprintSeed,
          releaseLock: () => {},
        };
      }
      contentFingerprint = deterministicGuard.fingerprint;

      let matchesAfterAckFilter: DuplicateMatch[] = [];
      try {
        if (deterministicGuard.action === "duplicate" && deterministicGuard.existing) {
          throw conflict("duplicate_candidates", {
            matches: [{
              id: deterministicGuard.existing.id,
              title: deterministicGuard.existing.title ?? "",
              description: deterministicGuard.existing.description ?? "",
              column: deterministicGuard.existing.column,
              score: 1,
              deterministic: true,
            }],
          });
        }

        const duplicateMatches = bypassDuplicateCheck === true
          ? []
          : await computeDuplicateMatches(scopedStore, {
              title: normalizedTitle,
              description: normalizedDescription,
            });
        matchesAfterAckFilter = duplicateMatches.filter((match) => !acknowledgedDuplicateIds.includes(match.id));
        if (matchesAfterAckFilter.length > 0) {
          throw conflict("duplicate_candidates", { matches: matchesAfterAckFilter });
        }

      // FN-5152: layered dedup ordering remains deterministic -> similarity -> near-duplicate intent.
      // This guard is fail-open so intake cannot be blocked by extraction/query errors.
      if (bypassDuplicateCheck !== true) {
        try {
          const signalCount = intentSignature.routePaths.length + intentSignature.filePaths.length + intentSignature.identifiers.length;
          if (signalCount > 0) {
            const duplicateQuery = buildDuplicateQuery(normalizedTitle, normalizedDescription);
            const nearDuplicateQueryTokens = [
              duplicateQuery,
              ...intentSignature.routePaths,
              ...intentSignature.identifiers,
            ].filter((token) => token.trim().length > 0);
            let candidateRows = await scopedStore.searchTasks(nearDuplicateQueryTokens.join(" "), {
              slim: true,
              includeArchived: false,
              limit: 50,
            });
            if (candidateRows.length === 0) {
              candidateRows = await scopedStore.listTasks({ slim: true, includeArchived: false, limit: 50 });
            }
            const fullRows = await scopedStore.listTasks({ slim: false, includeArchived: false });
            const byId = new Map(fullRows.map((row) => [row.id, row]));
            const candidateMap = new Map<string, NearDuplicateCandidate>();
            for (const row of candidateRows) {
              if (acknowledgedDuplicateIds.includes(row.id)) {
                continue;
              }
              const full = byId.get(row.id);
              candidateMap.set(row.id, {
                id: row.id,
                title: row.title ?? "",
                description: row.description ?? "",
                column: row.column,
                createdAt: full?.createdAt ? Date.parse(full.createdAt) : undefined,
                fileScope: Array.isArray(full?.sourceMetadata?.fileScope)
                  ? full.sourceMetadata.fileScope.filter((entry): entry is string => typeof entry === "string")
                  : undefined,
              });
            }
            const nearMatches = findNearDuplicates(
              { title: normalizedTitle, description: normalizedDescription },
              Array.from(candidateMap.values()),
              { windowMs: 7 * 24 * 60 * 60 * 1000 },
            );
            if (nearMatches.length > 0) {
              throw conflict("duplicate_candidates", {
                matches: nearMatches.map((match) => {
                  const candidate = candidateMap.get(match.id);
                  return {
                    id: match.id,
                    title: candidate?.title ?? "",
                    description: candidate?.description ?? "",
                    column: candidate?.column ?? "triage",
                    score: match.score,
                    reason: "near-duplicate-intent",
                    sharedTokens: match.sharedTokens,
                  };
                }),
              });
            }
          }
        } catch (error) {
          if (error instanceof ApiError) {
            throw error;
          }
          runtimeLogger.warn("Near-duplicate intent guard failed; proceeding", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // FN-5220: layered intake ordering remains deterministic -> similarity -> near-duplicate intent -> explicit-marker.
      try {
        const combinedText = `${normalizedTitle ?? ""}\n${normalizedDescription}`;
        const explicitDuplicateMarker = parseExplicitDuplicateMarker(combinedText);
        const explicitMarkerBypassed =
          bypassDuplicateCheck === true ||
          (explicitDuplicateMarker ? acknowledgedDuplicateIds.includes(explicitDuplicateMarker.canonicalId) : false);
        if (explicitDuplicateMarker && !explicitMarkerBypassed) {
          const canonical = await scopedStore.getTask(explicitDuplicateMarker.canonicalId).catch(() => null);
          if (canonical && !canonical.deletedAt) {
            try {
              // The intake guard runs before createTask, so there is no new task row yet.
              // Record against the canonical target to leave a traceable audit breadcrumb.
              await scopedStore.recordActivity({
                type: "task:auto-archived-duplicate",
                taskId: canonical.id,
                taskTitle: canonical.title ?? "",
                details: `Rejected explicit duplicate-marker intake redirect to ${canonical.id}`,
                metadata: {
                  canonicalTaskId: canonical.id,
                  source: "explicit-marker-intake",
                },
              });
            } catch (activityError) {
              runtimeLogger.warn("Explicit duplicate-marker intake activity recording failed; proceeding with conflict response", {
                canonicalTaskId: canonical.id,
                error: activityError instanceof Error ? activityError.message : String(activityError),
              });
            }
            throw conflict("duplicate_candidates", {
              matches: [{
                id: canonical.id,
                title: canonical.title ?? "",
                description: canonical.description ?? "",
                column: canonical.column,
                score: 1,
                reason: "explicit-marker",
              }],
            });
          }
        }
      } catch (error) {
        if (error instanceof ApiError) {
          throw error;
        }
        runtimeLogger.warn("Explicit duplicate-marker intake guard failed; proceeding", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const normalizedTaskSource = normalizedSource as TaskSource;
      const createInput = {
        title: normalizedTitle,
        description: normalizedDescription,
        column,
        dependencies,
        breakIntoSubtasks,
        enabledWorkflowSteps,
        // U6/R3: forward only when the client set it (string | null). Leaving it
        // absent preserves the project-default inheritance behavior.
        ...(workflowId !== undefined ? { workflowId: workflowId as string | null } : {}),
        modelPresetId: validateOptionalModelField(modelPresetId, "modelPresetId"),
        modelProvider: executorModel.provider ?? undefined,
        modelId: executorModel.modelId ?? undefined,
        validatorModelProvider: validatorModel.provider ?? undefined,
        validatorModelId: validatorModel.modelId ?? undefined,
        planningModelProvider: planningModel.provider ?? undefined,
        planningModelId: planningModel.modelId ?? undefined,
        thinkingLevel: thinkingLevel || undefined,
        summarize,
        reviewLevel: reviewLevel ?? undefined,
        executionMode: executionMode || undefined,
        ...(typeof autoMerge === "boolean" ? { autoMerge } : {}),
        priority: priority ?? undefined,
        source: {
          ...normalizedTaskSource,
          sourceMetadata: {
            ...(normalizedTaskSource.sourceMetadata ?? {}),
            ...(contentFingerprint ? { contentFingerprint } : {}),
            ...(intentSignature.routePaths.length + intentSignature.filePaths.length + intentSignature.identifiers.length > 0
              ? { intentSignature }
              : {}),
            ...(acknowledgedDuplicateIds.length > 0
              ? {
                  duplicateWarningOverridden: true,
                  acknowledgedDuplicateIds,
                }
              : {}),
          },
        },
        branch: normalizedBranch,
        baseBranch: normalizedBaseBranch,
        ...(typeof nodeId === "string" && nodeId.trim().length > 0 ? { nodeId: nodeId.trim() } : {}),
        ...(validatedGithubTracking ? { githubTracking: validatedGithubTracking } : {}),
      };

      const task = await scopedStore.createTask(
        createInput,
        { onSummarize, settings: { autoSummarizeTitles: settings.autoSummarizeTitles } },
      );

      // Newly created tasks are still triage/todo and cannot be worktree-acquired until
      // moved to in-progress, so this in-request branch update is safe.
      const taskWithAutoBranch = requestedBranchMode === "auto-new"
        ? await scopedStore.updateTask(task.id, {
            branch: deriveAutoTaskBranch(
              task.id,
              (((task.title ?? "").trim() || task.description).slice(0, 60)),
            ),
          })
        : task;

      const taskWithBranchContext = requestedBranchMode === "shared-group" && sharedFeatureBranch
        ? await (async () => {
            const group = scopedStore.getBranchGroupByBranchName(sharedFeatureBranch)
              ?? scopedStore.ensureBranchGroupForSource("new-task", sharedFeatureBranch, { branchName: sharedFeatureBranch });
            await scopedStore.setTaskBranchGroup(taskWithAutoBranch.id, group.id);
            const taskSegment = ((taskWithAutoBranch.title ?? "").trim() || taskWithAutoBranch.description).slice(0, 60);
            const workingBranch = derivePerTaskBranch(sharedFeatureBranch, taskSegment);
            return scopedStore.updateTask(taskWithAutoBranch.id, { branch: workingBranch });
          })()
        : taskWithAutoBranch;

      const deterministicReconcile = await reconcileDeterministicDuplicate(scopedStore, {
        createdTask: taskWithBranchContext,
        fingerprint: bypassDuplicateCheck === true ? null : contentFingerprint,
        windowMs: 60_000,
        logger: runtimeLogger,
      });
        if (deterministicReconcile.outcome === "archived") {
          res.status(200).json(deterministicReconcile.canonical);
          return;
        }

        if (acknowledgedDuplicateIds.length > 0) {
          try {
            await scopedStore.recordActivity({
              type: "task:duplicate-warning-overridden",
              taskId: taskWithBranchContext.id,
              taskTitle: taskWithBranchContext.title,
              details: `Created despite ${acknowledgedDuplicateIds.length} possible duplicate(s): ${acknowledgedDuplicateIds.join(", ")}`,
              metadata: {
                acknowledgedDuplicateIds,
                matches: matchesAfterAckFilter.map((match) => ({ id: match.id, score: match.score })),
              },
            });
          } catch (error) {
            runtimeLogger.warn("Failed to record duplicate warning override activity", {
              taskId: task.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        res.status(201).json(taskWithBranchContext);
        return;
      } finally {
        deterministicGuard.releaseLock();
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      // U6/R3: workflowId validation failures from the store (unknown id /
      // fragment id) are client errors, not server faults.
      const isClientError =
        message.includes("must be a string")
        || message.includes("must be an array of strings")
        || /^Workflow '.*' not found$/.test(message)
        || /is a fragment and cannot be selected/.test(message);
      const status = isClientError ? 400 : 500;
      throw new ApiError(status, message);
    }
  });

  // Move task to column
  router.post("/tasks/:id/move", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { column, preserveProgress } = req.body;
      if (!column || !COLUMNS.includes(column as Column)) {
        throw badRequest(`Invalid column. Must be one of: ${COLUMNS.join(", ")}`);
      }
      if (preserveProgress != null && typeof preserveProgress !== "boolean") {
        throw badRequest("preserveProgress must be a boolean");
      }

      // R16: block moving a PR-await task "backward" (e.g. in-review → in-progress)
      // while it still has an open PR entity. The PR's lifecycle is workflow-owned;
      // dragging the card back would orphan the open GitHub PR. The user must
      // merge or close the PR first (a user-controlled release advances it
      // forward; this guard only rejects backward drags). Once the entity is
      // terminal (merged/closed/failed) the move is allowed.
      const moveTarget = column as Column;
      const guardTask = await scopedStore.getTask(req.params.id);
      if (guardTask) {
        const activePrEntity =
          scopedStore.getActivePrEntityBySource?.("task", guardTask.id) ??
          (guardTask.branchContext?.groupId
            ? scopedStore.getActivePrEntityBySource?.("branch-group", guardTask.branchContext.groupId)
            : null);
        if (
          isBackwardMoveBlockedByOpenPr({
            fromIndex: COLUMNS.indexOf(guardTask.column as Column),
            toIndex: COLUMNS.indexOf(moveTarget),
            activePrEntity,
          })
        ) {
          throw new ApiError(409, PR_OPEN_BLOCKS_MOVE_BACK_MESSAGE, {
            code: "pr-open-blocks-move-back",
            messageKey: "board.rejection.prOpenBlocksMoveBack",
            retryable: false,
          });
        }
      }

      // When manually promoting to in-progress, supply an allocator so
      // moveTask assigns a worktree path under its cross-task allocation
      // lock. This mirrors scheduler dispatch semantics — without it, a
      // user-initiated move would land the task in-progress with a stale
      // (or null) worktree and could collide with another active task.
      // The executor's createWorktree path will reuse `task.branch` if it
      // already exists, so any prior committed progress survives even
      // though the on-disk worktree directory is freshly allocated.
      let allocateWorktree: ((reservedNames: Set<string>) => string | null) | undefined;
      if ((column as Column) === "in-progress") {
        const existing = await scopedStore.getTask(req.params.id);
        if (existing) {
          const settings = await scopedStore.getSettings();
          const rootDir = scopedStore.getRootDir();
          allocateWorktree = (reservedNames) =>
            planTaskWorktreePath(existing, rootDir, settings.worktreeNaming, reservedNames, settings);
        }
      }

      const task = await scopedStore.moveTask(req.params.id, column as Column, {
        preserveProgress,
        allocateWorktree,
        moveSource: "user",
      });
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      // Flag-ON typed rejections surface as a structured 409 so the board can
      // resolve the i18n messageKey and decide snap-back vs no-move (U9/R17).
      // Flag-OFF legacy errors are unchanged (the legacy strings below).
      if (err instanceof TransitionRejectionError) {
        throw new ApiError(409, err.message, {
          code: err.rejection.code,
          messageKey: err.rejection.messageKey,
          retryable: err.rejection.retryable,
        });
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("Invalid transition") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Manually promote a held card out of its hold column (U9). Releases via the
  // same authority as the hold/release sweep; the in-txn capacity check still
  // arbitrates, so a promote into a full column rejects with capacity-exhausted.
  router.post("/tasks/:id/promote", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettingsFast();
      if (!isWorkflowColumnsEnabled(settings)) {
        throw badRequest("Workflow columns are not enabled");
      }
      const existing = await scopedStore.getTask(req.params.id);
      const rootDir = scopedStore.getRootDir();
      const allocateWorktree = existing
        ? (task: Task, reservedNames: Set<string>) =>
            planTaskWorktreePath(task, rootDir, settings.worktreeNaming, reservedNames, settings)
        : undefined;

      const result = await promoteHeldTask(scopedStore, req.params.id, { allocateWorktree });
      if (!result.released) {
        if (result.rejection === "capacity-exhausted-or-no-slot") {
          throw new ApiError(409, "Downstream column is at capacity", {
            code: "capacity-exhausted",
            messageKey: "board.rejection.capacityExhausted",
            retryable: true,
          });
        }
        throw new ApiError(409, result.rejection ?? "Promote rejected", {
          code: "guard-rejected",
          messageKey: "board.rejection.promoteRejected",
          retryable: false,
        });
      }
      const task = await scopedStore.getTask(req.params.id);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof TransitionRejectionError) {
        throw new ApiError(409, err.message, {
          code: err.rejection.code,
          messageKey: err.rejection.messageKey,
          retryable: err.rejection.retryable,
        });
      }
      rethrowAsApiError(err);
    }
  });

  // Merge task (in-review → done, merges branch + cleans worktree)
  // Uses AI merge handler if provided, falls back to store.mergeTask
  router.post("/tasks/:id/merge", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      const merge = engine
        ? (id: string) => {
          // Manual merge: bypasses scheduler-transient status blockers (FN-5438). Hard guards still apply.
          return engine.onMerge(id);
        }
        : options?.onMerge ?? ((id: string) => scopedStore.mergeTask(id));
      const result = await merge(req.params.id);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("Cannot merge") ? 400
        : (err instanceof Error ? err.message : String(err)).includes("conflict") ? 409
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /*
  FNXC:TaskRevert 2026-07-04-00:00 (FN-7524 mode contract; FN-7547 workspace dispatch; FN-7548 granularity contract):
  POST /tasks/:id/revert — intelligent git-revert for Done/Archived tasks (FN-7523), with an
  AI-undo fallback (FN-7524, foundation for FN-7501), workspace (multi-repo) task support
  (FN-7547), and per-sha revert-commit granularity (FN-7548). Guard rails (enforced here AND in
  the engine service):
    - only done/archived tasks are revertable (400/409 otherwise);
    - autoMerge-off is a needsHuman result, not a forced write, and NEVER triggers the AI fallback
      (leave that for a human / sibling FN-7525 to decide);
    - the source task's column/status is NEVER mutated as a side effect of a revert (git OR AI path).

  Optional request body:
    - `mode?: "git" | "ai" | "auto"` (default `"auto"`; unknown values reject with 400). Semantics:
      - `"git"`  — FN-7523 behavior only; the git result (incl. a conflict/unsupported result) is
        returned as-is and the AI-undo path is NEVER invoked.
      - `"ai"`   — skip git entirely; always take the AI-undo fallback.
      - `"auto"` — attempt git first. A clean/alreadyReverted/needsHuman git result is returned
        unchanged (NO AI task created). A conflicting or unsupported git result falls through to
        the AI-undo fallback.
    - `granularity?: "squash" | "per-sha"` (FN-7548, default `"squash"`) — commit granularity for the
      single-repo git-path revert only; forwarded verbatim to `performTaskRevert`. `"squash"`
      preserves the unchanged FN-7523 single-commit behavior; `"per-sha"` creates one attributed
      revert commit per original sha (see `performTaskRevert`'s per-sha apply path). Ignored when
      `mode` resolves to `"ai"` or the task is a workspace task.

  Response contract is ADDITIVE over FN-7523: `{ mode: "git", clean, revertCommitSha?, revertCommitShas?,
  conflicts?, alreadyReverted?, unsupported?, needsHuman?, reason? }` OR, for workspace tasks (FN-7547),
  `{ mode: "git", clean, workspace: { repos: [{ repo, classification, revertCommitSha?, conflicts?,
  alreadyReverted? }] }, conflicts?: {repo, file, ...}[] }` OR
  `{ mode: "ai", createdTaskId: "FN-YYYY", alreadyOpen?: true }` OR, for a single-repo task under
  `autoMerge:false` (FN-7554), `{ mode: "pr", clean: true, prUrl, prNumber, revertBranch, existingPr? }`
  OR, for a WORKSPACE task under `autoMerge:false` (FN-7577 — additive over FN-7554/FN-7547),
  `{ mode: "pr", clean: true, workspace: { repos: [{ repo, revertBranch, prUrl, prNumber, existingPr? }] } }`
  — one revert PR opened per sub-repo, all-or-nothing at the branch-prep phase
  (`prepareWorkspaceRevertPrBranches`), never force-writing any sub-repo integration branch. The
  AI-undo task is created via `createAiUndoTask` (engine) + `TaskStore.findOpenRevertTaskForSource`
  (core) for the idempotency guard — a second call while an undo task is still open returns the
  SAME `createdTaskId` with `alreadyOpen: true` rather than creating a duplicate.
  */
  router.post("/tasks/:id/revert", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (!task) {
        throw notFound(`Task ${req.params.id} not found`);
      }
      if (task.column !== "done" && task.column !== "archived") {
        throw conflict(`Task ${task.id} is in column "${task.column}"; only done/archived tasks can be reverted`);
      }

      const requestedMode = (req.body as { mode?: unknown } | undefined)?.mode;
      if (requestedMode !== undefined && requestedMode !== "git" && requestedMode !== "ai" && requestedMode !== "auto") {
        throw badRequest(`Invalid revert mode "${String(requestedMode)}"; expected "git", "ai", or "auto"`);
      }
      const mode: "git" | "ai" | "auto" = (requestedMode as "git" | "ai" | "auto" | undefined) ?? "auto";

      /*
      FNXC:TaskRevert 2026-07-04-12:00 (FN-7548):
      Optional `granularity` request-body field selects the commit granularity
      of the revert: `"squash"` (default, unchanged FN-7523 behavior — one
      combined revert commit) or `"per-sha"` (one attributed revert commit per
      original sha, see `performTaskRevert`'s per-sha apply path). An absent/
      empty value defaults to `"squash"`; any other value is a 400 naming the
      allowed values. Only relevant to the single-repo git path — ignored when
      `mode` resolves to `"ai"` or the task is a workspace task.
      */
      const requestedGranularity = (req.body as { granularity?: unknown } | undefined)?.granularity;
      let granularity: "squash" | "per-sha" = "squash";
      if (requestedGranularity !== undefined && requestedGranularity !== null && requestedGranularity !== "") {
        if (requestedGranularity !== "squash" && requestedGranularity !== "per-sha") {
          throw badRequest(`granularity must be one of: "squash", "per-sha"`);
        }
        granularity = requestedGranularity;
      }

      /*
      FNXC:TaskRevert 2026-07-05-00:00 (FN-7556):
      `settings` is fetched HERE (before `createAiUndoResult` is defined/used)
      because the `mode === "ai"` early-return path below uses the closure
      before the git-path `settings` fetch that used to follow it. AI-undo
      tasks default to the `aiUndoTaskWorkflowId` project setting (default
      `builtin:review-heavy` — a stricter review posture than ordinary new
      work, since these tasks reverse already-shipped code). A blank/whitespace
      value means inherit the project default workflow; a non-blank value that
      does not resolve to a real workflow (custom or builtin) is logged and
      falls back to inherit too — a misconfigured id must never break AI-undo
      task creation.
      */
      const settings = await scopedStore.getSettingsFast();
      const configuredAiUndoWorkflowId = settings.aiUndoTaskWorkflowId?.trim();
      let aiUndoWorkflowId: string | undefined;
      if (configuredAiUndoWorkflowId) {
        const exists =
          isBuiltinWorkflowId(configuredAiUndoWorkflowId) || Boolean(await scopedStore.getWorkflowDefinition(configuredAiUndoWorkflowId));
        if (exists) {
          aiUndoWorkflowId = configuredAiUndoWorkflowId;
        } else {
          console.warn(
            `[task-revert] aiUndoTaskWorkflowId "${configuredAiUndoWorkflowId}" does not resolve to a known workflow; AI-undo task will inherit the project default workflow instead`,
          );
        }
      }

      const createAiUndoResult = async (): Promise<AiUndoTaskResult> =>
        createAiUndoTask({
          createTask: (input) => scopedStore.createTask(input),
          findOpenRevertTaskForSource: (id) => scopedStore.findOpenRevertTaskForSource(id),
          sourceTask: task,
          workflowId: aiUndoWorkflowId,
        });

      if (mode === "ai") {
        res.json(await createAiUndoResult());
        return;
      }

      const rootDir = scopedStore.getRootDir();

      /*
      FNXC:TaskRevert 2026-07-04-00:00 (FN-7547 — workspace dispatch):
      Workspace tasks (`isWorkspaceTask(task)`) land commits across MULTIPLE
      sub-repo integration branches under `rootDir` (each sub-repo lives at
      `join(rootDir, repoRel)`, mirroring `landWorkspaceTask`) — there is no
      single `baseBranch`/`rootDir`-is-a-git-repo assumption to check here.
      Route straight to `revertWorkspaceTask`, which resolves + branch-checks
      + dry-run classifies + commits EACH sub-repo itself, enforcing the
      whole-task all-or-nothing contract. The single-repo path below is
      UNCHANGED. `granularity` does not apply to the workspace path.
      */
      if (isWorkspaceTask(task)) {
        /*
        FNXC:TaskRevert 2026-07-05-00:00 (FN-7577 — workspace mode:"pr" dispatch,
        additive over FN-7554/FN-7547): `revertWorkspaceTask` refuses
        (`needsHuman`) whenever autoMerge is effectively off, the same dead end
        `performTaskRevert` hits for single-repo tasks. Instead of stopping
        there, take the multi-PR path: `prepareWorkspaceRevertPrBranches`
        classifies EVERY sub-repo first and only prepares one dedicated
        `fusion/revert-<id>` branch per sub-repo (never writing any sub-repo
        integration branch) when every sub-repo is clean/already-reverted; this
        route then opens ONE revert PR per prepared sub-repo branch, reusing
        FN-7554's per-repo owner/repo resolution, rate-limiter gate,
        `findPrForBranch` idempotency, and `manual:true` handoff. The
        `autoMerge:true` workspace path below (the existing `revertWorkspaceTask`
        call) is UNCHANGED.
        */
        const effectiveAutoMerge = task.autoMerge ?? settings.autoMerge ?? true;

        if (effectiveAutoMerge === false) {
          const revertBranch = `fusion/revert-${task.id.toLowerCase()}`;

          const prepared: PrepareWorkspaceRevertPrBranchesResult = await prepareWorkspaceRevertPrBranches({
            task,
            workspaceRootDir: rootDir,
            settings,
            revertBranch,
            commitAssociationSource: {
              getTaskCommitAssociationsByLineageId: (lineageId: string) =>
                scopedStore.getTaskCommitAssociationsByLineageId(lineageId),
            },
          });

          if (!prepared.eligible) {
            if ("classification" in prepared && prepared.classification === "conflicting") {
              if (mode === "auto") {
                res.json(await createAiUndoResult());
                return;
              }
              res.json({ mode: "git", clean: false, workspace: { repos: prepared.repos }, conflicts: prepared.conflicts });
              return;
            }
            if ("unsupported" in prepared && prepared.unsupported) {
              if (mode === "auto") {
                res.json(await createAiUndoResult());
                return;
              }
              res.json({ mode: "git", unsupported: true, reason: prepared.reason });
              return;
            }
          }

          if (prepared.eligible) {
            // prepared.eligible === true
            if (prepared.repos.length === 0) {
              // Every sub-repo was already-reverted — nothing to PR.
              res.json({ mode: "git", clean: true, workspace: { repos: [] } });
              return;
            }

            /*
            FNXC:TaskRevert 2026-07-05-00:00 (FN-7577 — atomic pre-check ordering):
            Resolve owner/repo AND check the rate limiter for EVERY prepared
            sub-repo BEFORE pushing/creating any PR, so the two common degrade
            cases (GitHub unconfigured / rate-limited) never leave a partial
            subset of PRs open across sub-repos. Nothing has been pushed to any
            remote yet at this point, so degrading here only needs to delete the
            purely-local prepared branches.
            */
            const cleanupPreparedBranches = async (): Promise<void> => {
              for (const repoBranch of prepared.repos) {
                const repoRootDir = join(rootDir, repoBranch.repo);
                await runGitCommand(["checkout", repoBranch.integrationBranch], repoRootDir, 10_000).catch(() => undefined);
                await runGitCommand(["branch", "-D", revertBranch], repoRootDir, 10_000).catch(() => undefined);
              }
            };

            const targets: { repoBranch: WorkspaceRepoRevertPrBranch; owner: string; repo: string }[] = [];
            for (const repoBranch of prepared.repos) {
              const gitRepo = getCurrentRepo(join(rootDir, repoBranch.repo));
              if (!gitRepo) {
                await cleanupPreparedBranches();
                res.json({
                  mode: "git",
                  needsHuman: true,
                  reason: "autoMerge is disabled and one or more sub-repos have no GitHub repository configured; cannot open revert PRs",
                });
                return;
              }
              targets.push({ repoBranch, owner: gitRepo.owner, repo: gitRepo.repo });
            }

            for (const target of targets) {
              const repoKey = `${target.owner}/${target.repo}`;
              if (!githubRateLimiter.canMakeRequest(repoKey)) {
                await cleanupPreparedBranches();
                res.json({
                  mode: "git",
                  needsHuman: true,
                  reason: "GitHub API rate limit exceeded; try again later",
                });
                return;
              }
            }

            /*
            FNXC:TaskRevert 2026-07-05-00:00 (FN-7577 — idempotent multi-PR
            recovery contract): from this point on, a thrown error (network down,
            push rejected, GitHub 5xx, etc.) is surfaced via the shared `catch`
            below rather than a graceful needsHuman degrade, because an earlier
            sub-repo in this loop may already have an open remote PR by the time a
            later sub-repo fails — this route NEVER attempts to close/delete an
            already-created remote PR. A re-run of this endpoint is safe:
            `findPrForBranch` links any already-created sub-repo PR instead of
            re-creating it, and `prepareWorkspaceRevertPrBranches`'s `checkout -B`
            re-preps local branches for any sub-repo not yet pushed.
            */
            const resultRepos: { repo: string; revertBranch: string; prUrl: string; prNumber: number; existingPr?: boolean }[] = [];
            const persistPrInfo = async (prInfo: PrInfo): Promise<void> => {
              const existingPrs = task.prInfos ?? (task.prInfo ? [task.prInfo] : []);
              if (existingPrs.length > 0) {
                await scopedStore.addPrInfo(task.id, prInfo);
              } else {
                await scopedStore.updatePrInfo(task.id, prInfo);
              }
            };

            for (const target of targets) {
              const client = new GitHubClient();
              const existingPr = await client.findPrForBranch({ head: revertBranch, state: "all", owner: target.owner, repo: target.repo });

              if (existingPr) {
                // Idempotency — never re-push/re-create when an open (or all-state)
                // PR already exists for this sub-repo's branch, just link it.
                const prInfo: PrInfo = { ...existingPr, manual: true };
                await persistPrInfo(prInfo);
                await scopedStore.logEntry(task.id, "Linked existing revert PR", `${target.repoBranch.repo}: PR #${prInfo.number}: ${prInfo.url}`);
                resultRepos.push({ repo: target.repoBranch.repo, revertBranch, prUrl: prInfo.url, prNumber: prInfo.number, existingPr: true });
                continue;
              }

              await runGitCommand(["push", "-u", "origin", revertBranch], join(rootDir, target.repoBranch.repo), 60_000);
              const prTitle = `revert(${task.id}): undo landed work (${target.repoBranch.repo})`;
              const prBody =
                `This PR reverts the work landed by task ${task.id} in sub-repo \`${target.repoBranch.repo}\`.\n\n` +
                `See \`GET /api/tasks/${task.id}/diff\` for the full landed diff being reverted.\n`;
              const created = await client.createPr({
                owner: target.owner,
                repo: target.repo,
                title: prTitle,
                body: prBody,
                head: revertBranch,
                base: target.repoBranch.integrationBranch,
              });
              const prInfo: PrInfo = { ...created, manual: true };
              await persistPrInfo(prInfo);
              await scopedStore.logEntry(task.id, "Created revert PR", `${target.repoBranch.repo}: PR #${prInfo.number}: ${prInfo.url}`);
              resultRepos.push({ repo: target.repoBranch.repo, revertBranch, prUrl: prInfo.url, prNumber: prInfo.number });
            }

            res.json({ mode: "pr", clean: true, workspace: { repos: resultRepos } });
            return;
          }
        }

        const workspaceResult = await revertWorkspaceTask({
          task,
          workspaceRootDir: rootDir,
          settings,
          commitAssociationSource: {
            getTaskCommitAssociationsByLineageId: (lineageId: string) =>
              scopedStore.getTaskCommitAssociationsByLineageId(lineageId),
          },
          effectiveAutoMerge: settings.autoMerge,
        });

        if (mode === "git") {
          res.json(workspaceResult);
          return;
        }

        // mode === "auto": fall back to the AI-undo task on a conflicting workspace
        // result, same as the single-repo conflicting-result contract below.
        const workspaceShouldFallBackToAi = workspaceResult.mode === "git" && "clean" in workspaceResult && workspaceResult.clean === false;
        if (workspaceShouldFallBackToAi) {
          res.json(await createAiUndoResult());
          return;
        }

        res.json(workspaceResult);
        return;
      }

      const baseBranch = task.mergeDetails?.mergeTargetBranch || await resolveIntegrationBranch(rootDir, settings);

      /*
      FNXC:TaskRevert 2026-07-04-00:00:
      `rootDir` (`scopedStore.getRootDir()`) is the SHARED user checkout, not a
      dedicated per-task worktree — `computeExtendedGitStatus`'s `isOnIntegrationBranch`
      handling and `pullGitBranch`'s integration-worktree branch-mismatch guard both
      document that this checkout can legitimately be on any branch at any time (e.g.
      a user mid-review on a feature branch). `performTaskRevert` mutates `worktreePath`
      in place (dry-run revert + real commit on "the appropriate base branch"), so
      without this check a revert requested while rootDir sits on a different branch
      would silently apply/commit the revert onto THAT branch instead of `baseBranch` —
      committing to the wrong branch is worse than refusing. Mirror `pullGitBranch`'s
      `branch-mismatch` 409 contract here rather than assuming the caller pre-checked out.
      */
      const currentBranch = (await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], rootDir, 5_000)).trim();
      if (currentBranch !== baseBranch) {
        throw new ApiError(409, `Checkout is on "${currentBranch}", not the task's base branch "${baseBranch}"; switch to "${baseBranch}" before reverting`, {
          code: "branch-mismatch",
          currentBranch,
          baseBranch,
        });
      }

      /*
      FNXC:TaskRevert 2026-07-05-00:00 (FN-7554 — mode:"pr" contract, additive over FN-7523/24/47/48):
      `performTaskRevert` refuses (`needsHuman`) whenever autoMerge is
      effectively off, because it would otherwise force-write a revert commit
      directly onto `baseBranch` — a branch this project has opted out of
      automated writes to. Instead of stopping at that dead end, open a real
      revert PR: `prepareRevertPrBranch` (engine) applies the revert commit(s)
      onto a DEDICATED `fusion/revert-<id>` branch off `baseBranch` HEAD
      (never mutating `baseBranch` itself), then this route pushes that branch
      and opens a PR via `GitHubClient.createPr` — reusing the exact
      owner/repo resolution, `githubRateLimiter` gate, `findPrForBranch`
      idempotency, and `manual: true` handoff that `/pr/create` already uses.
      This ONLY applies to the single-repo git path (workspace tasks already
      returned above) and ONLY for `mode !== "ai"` (the `mode === "ai"` case
      already returned earlier in this handler). Every existing
      `{ mode: "git" | "ai", ... }` result shape is unchanged — this adds a
      new `{ mode: "pr", ... }` variant. Graceful `needsHuman` degrade (NOT a
      thrown error) covers: GitHub unconfigured, and GitHub rate-limited —
      both leave the caller with the same actionable `needsHuman` contract
      the `autoMerge:true` code path never has to think about.
      PR-based revert of WORKSPACE (multi-repo) tasks under autoMerge:false is
      explicitly deferred (would require per-sub-repo branches + multiple
      PRs) — see the FN-7554 follow-up task; workspace tasks above still get
      the existing `needsHuman` result from `revertWorkspaceTask`.
      */
      const effectiveAutoMerge = task.autoMerge ?? settings.autoMerge ?? true;
      if (effectiveAutoMerge === false) {
        let owner: string;
        let repo: string;
        const envRepo = process.env.GITHUB_REPOSITORY;
        if (envRepo) {
          const [o, r] = envRepo.split("/");
          owner = o;
          repo = r;
        } else {
          const gitRepo = getCurrentRepo(rootDir);
          if (!gitRepo) {
            res.json({
              mode: "git",
              needsHuman: true,
              reason: "autoMerge is disabled and no GitHub repository is configured; cannot open a revert PR",
            });
            return;
          }
          owner = gitRepo.owner;
          repo = gitRepo.repo;
        }

        const repoKey = `${owner}/${repo}`;
        if (!githubRateLimiter.canMakeRequest(repoKey)) {
          res.json({
            mode: "git",
            needsHuman: true,
            reason: "GitHub API rate limit exceeded; try again later",
          });
          return;
        }

        const revertBranch = `fusion/revert-${task.id.toLowerCase()}`;
        const client = new GitHubClient();
        let existingPr: Awaited<ReturnType<typeof client.findPrForBranch>>;
        try {
          existingPr = await client.findPrForBranch({ head: revertBranch, state: "all", owner, repo });
        } catch (error) {
          // FNXC:TaskRevert 2026-07-05-00:00 (FN-7554): GitHub reachability failure
          // (network down, auth rejected, 5xx, etc.) degrades to needsHuman with an
          // explicit reason rather than bubbling up as a 500 — mirrors the
          // no-remote-configured / rate-limited degrade paths above.
          res.json({
            mode: "git",
            needsHuman: true,
            reason: `GitHub is unavailable; could not check for an existing revert PR (${error instanceof Error ? error.message : String(error)})`,
          });
          return;
        }

        const persistPrInfo = async (prInfo: PrInfo): Promise<void> => {
          const existingPrs = task.prInfos ?? (task.prInfo ? [task.prInfo] : []);
          if (existingPrs.length > 0) {
            await scopedStore.addPrInfo(task.id, prInfo);
          } else {
            await scopedStore.updatePrInfo(task.id, prInfo);
          }
        };

        if (existingPr) {
          // Idempotency — mirrors `/pr/create`: never re-prepare/re-push when an
          // open (or all-state) PR already exists for this branch, just link it.
          const prInfo: PrInfo = { ...existingPr, manual: true };
          await persistPrInfo(prInfo);
          await scopedStore.logEntry(task.id, "Linked existing revert PR", `PR #${prInfo.number}: ${prInfo.url}`);
          res.json({
            mode: "pr",
            clean: true,
            prUrl: prInfo.url,
            prNumber: prInfo.number,
            revertBranch,
            existingPr: true,
          });
          return;
        }

        const prepared: PrepareRevertPrBranchResult = await prepareRevertPrBranch({
          task,
          worktreePath: rootDir,
          baseBranch,
          revertBranch,
          commitAssociationSource: {
            getTaskCommitAssociationsByLineageId: (lineageId: string) =>
              scopedStore.getTaskCommitAssociationsByLineageId(lineageId),
          },
        });

        if (!prepared.eligible) {
          if ("alreadyReverted" in prepared && prepared.alreadyReverted) {
            res.json({ mode: "git", clean: true, alreadyReverted: true });
            return;
          }
          if ("classification" in prepared && prepared.classification === "conflicting") {
            if (mode === "auto") {
              res.json(await createAiUndoResult());
              return;
            }
            res.json({ mode: "git", clean: false, conflicts: prepared.conflicts });
            return;
          }
          if ("unsupported" in prepared && prepared.unsupported) {
            if (mode === "auto") {
              res.json(await createAiUndoResult());
              return;
            }
            res.json({ mode: "git", unsupported: true, reason: prepared.reason });
            return;
          }
        }

        if (prepared.eligible) {
          // FNXC:TaskRevert 2026-07-05-00:00 (FN-7554): push/create-PR failures
          // (network down, auth rejected, remote rejects push, GitHub 5xx, etc.)
          // degrade to needsHuman with an explicit reason instead of a thrown 500 —
          // the revert branch/commit(s) already prepared locally are left in place
          // (never force-written to `baseBranch`) so a retry can reuse them.
          try {
            await runGitCommand(["push", "-u", "origin", prepared.revertBranch], rootDir, 60_000);
            const prTitle = `revert(${task.id}): undo landed work`;
            const prBody =
              `This PR reverts the work landed by task ${task.id}.\n\n` +
`See \`GET /api/tasks/${task.id}/diff\` for the landed diff being reverted.\n`;
            const created = await client.createPr({
              owner,
              repo,
              title: prTitle,
              body: prBody,
              head: prepared.revertBranch,
              base: baseBranch,
            });
            const prInfo: PrInfo = { ...created, manual: true };
            await persistPrInfo(prInfo);
            await scopedStore.logEntry(task.id, "Created revert PR", `PR #${prInfo.number}: ${prInfo.url}`);
            res.json({
              mode: "pr",
              clean: true,
              prUrl: prInfo.url,
              prNumber: prInfo.number,
              revertBranch: prepared.revertBranch,
            });
            return;
          } catch (error) {
            res.json({
              mode: "git",
              needsHuman: true,
              reason: `GitHub is unavailable; could not push the revert branch or open the PR (${error instanceof Error ? error.message : String(error)})`,
            });
            return;
          }
        }
      }

      const result = await performTaskRevert({
        task,
        worktreePath: rootDir,
        baseBranch,
        commitAssociationSource: {
          getTaskCommitAssociationsByLineageId: (lineageId: string) =>
            scopedStore.getTaskCommitAssociationsByLineageId(lineageId),
        },
        effectiveAutoMerge: settings.autoMerge,
        granularity,
      });

      if (mode === "git") {
        res.json(result);
        return;
      }

      // mode === "auto": fall back to the AI-undo task ONLY on conflict or an
      // unsupported git result. Clean/alreadyReverted/needsHuman results are
      // returned as-is — needsHuman (autoMerge-off) NEVER triggers AI.
      const shouldFallBackToAi =
        (result.mode === "git" && "clean" in result && result.clean === false) ||
        (result.mode === "git" && "unsupported" in result && result.unsupported === true);

      if (shouldFallBackToAi) {
        res.json(await createAiUndoResult());
        return;
      }

      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof TaskRevertError) {
        const status = err.code === "dirty-working-tree" || err.code === "branch-mismatch" ? 409 : 500;
        throw new ApiError(status, err.message, { code: err.code });
      }
      rethrowAsApiError(err);
    }
  });

  // Retry failed, stuck-killed, or stranded triage/planning task
  router.post("/tasks/:id/retry", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      const retrySpecification =
        task.column === "triage" &&
        (task.status === "failed" ||
          task.status === "planning" ||
          task.status === "needs-replan" ||
          (task.stuckKillCount ?? 0) > 0);
      const isInReviewStatusNone =
        task.column === "in-review" && (task.status === null || task.status === undefined);
      const hasIncompleteSteps = task.steps.some(
        (s: { status: string }) => s.status === "pending" || s.status === "in-progress",
      );
      // FN-4130 / PR #59 follow-up: zero-step review failures with no merge attempts
      // (`mergeRetries ?? 0 === 0`) failed during execution, not merge finalization.
      const isExecutionFailureInReview =
        hasIncompleteSteps || (task.steps.length === 0 && (task.mergeRetries ?? 0) === 0);
      const isInReviewExecutionStall = isInReviewStatusNone && isExecutionFailureInReview;
      const isInReviewMergeRetryStall = isInReviewStatusNone && (task.mergeRetries ?? 0) > 0;
      const isInReviewRetry =
        task.column === "in-review" &&
        (task.status === "failed" ||
          task.status === "stuck-killed" ||
          isInReviewExecutionStall ||
          isInReviewMergeRetryStall);
      if (task.status !== "failed" && task.status !== "stuck-killed" && !retrySpecification && !isInReviewRetry) {
        throw badRequest(`Task is not in a retryable state (current status: ${task.status || 'none'})`);
      }

      /*
      FNXC:ManualRetry 2026-06-29-00:57:
      Dashboard retry is a fresh run boundary. Clear executor-only pause-abort provenance before mutating task state so stale pause/resume markers cannot relabel the next Plan Review or execution failure as an engine pause.
      */
      engine?.clearTaskPauseAbortState?.(req.params.id);

      const autoPauseClearPatch = buildAutoPauseClearPatch(task);
      const clearedDeadlockAutoPause = Object.keys(autoPauseClearPatch).length > 0;
      const retryLogSuffix = clearedDeadlockAutoPause ? ", cleared deadlock auto-pause" : "";

      // In-review retry: distinguish between execution failures (incomplete steps)
      // and merge failures (all steps done).
      if (isInReviewRetry) {
        if (isExecutionFailureInReview) {
          /*
          FNXC:WorkflowRetry 2026-06-29-02:18:
          Dashboard retry for an in-review execution failure re-enters the workflow graph from parse/execution, so it must clear persisted foreach step-instance pins. Otherwise a stale pin from the failed run makes the retry hit the same parse pin-mismatch immediately.
          */
          clearRebuiltSpecWorkflowPins(scopedStore, req.params.id);
          await scopedStore.updateTask(req.params.id, {
            status: null,
            error: null,
            ...autoPauseClearPatch,
            ...buildManualRetryResetPatch(),
          });
          await scopedStore.logEntry(
            req.params.id,
            isInReviewExecutionStall
              ? `Retry requested from dashboard (stranded in-review execution retry → todo, preserving progress${retryLogSuffix})`
              : `Retry requested from dashboard (execution failure in-review → todo, preserving progress${retryLogSuffix})`,
          );
          const updated = await scopedStore.moveTask(req.params.id, "todo", { preserveProgress: true });
          res.json(updated);
          return;
        }

        await scopedStore.updateTask(req.params.id, {
          status: null,
          error: null,
          ...autoPauseClearPatch,
          ...buildManualRetryResetPatch({ resetMergeRetries: true }),
        });
        await scopedStore.logEntry(req.params.id, `Retry requested from dashboard (in-review merge retry, mergeRetries reset${retryLogSuffix})`);
        const updated = await scopedStore.getTask(req.params.id);
        res.json(updated);
        return;
      }

      await scopedStore.updateTask(req.params.id, {
        status: retrySpecification ? "needs-replan" : null,
        error: null,
        worktree: null,
        branch: null,
        baseBranch: null,
        baseCommitSha: null,
        ...autoPauseClearPatch,
        ...buildManualRetryResetPatch({ resetMergeRetries: true }),
      });

      if (retrySpecification) {
        const { rm } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
        await rm(promptPath, { force: true });
        await scopedStore.logEntry(req.params.id, "Retry requested from dashboard (planning retry budget reset)");
        const updated = await scopedStore.getTask(req.params.id);
        res.json(updated);
        return;
      }

      /*
      FNXC:WorkflowRetry 2026-06-29-02:18:
      Non-planning manual retry is also a fresh execution boundary. Clear graph step-instance rows before moving back to todo so parse-steps can repin the current PROMPT.md instead of inheriting failed foreach state.
      */
      clearRebuiltSpecWorkflowPins(scopedStore, req.params.id);

      // Reset steps if the branch has no unique commits (work was lost with worktree)
      const completedSteps = task.steps.filter(
        (s: { status: string }) => s.status === "done" || s.status === "in-progress",
      );
      if (completedSteps.length > 0) {
        const branchName = task.branch || `fusion/${task.id.toLowerCase()}`;
        try {
          const rootDir = scopedStore.getRootDir();
          const mergeBase = (await runGitCommand(["merge-base", branchName, "HEAD"], rootDir, 5000)).trim();
          const branchHead = (await runGitCommand(["rev-parse", branchName], rootDir, 5000)).trim();

          if (mergeBase === branchHead) {
            for (let i = 0; i < task.steps.length; i++) {
              if (task.steps[i].status === "done" || task.steps[i].status === "in-progress") {
                await scopedStore.updateStep(req.params.id, i, "pending");
              }
            }
            await scopedStore.logEntry(
              req.params.id,
              `Reset ${completedSteps.length} step(s) to pending — branch had no commits (uncommitted work lost)`,
            );
          }
        } catch {
          // Branch may not exist — non-fatal, steps keep their status
        }
      }

      await scopedStore.logEntry(req.params.id, "Retry requested from dashboard (stuck kill budget reset)");
      const updated = await scopedStore.moveTask(req.params.id, "todo");
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Nuclear reset — erase all progress and allocate a fresh worktree+branch on next run
  router.post("/tasks/:id/reset", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);

      const { confirm: confirmed } = (req.body ?? {}) as { confirm?: boolean };
      if (!confirmed) {
        throw badRequest(
          "This operation is destructive and will erase all task progress. Pass { \"confirm\": true } in the request body to proceed.",
        );
      }

      const task = await scopedStore.getTask(req.params.id);

      engine?.clearTaskPauseAbortState?.(req.params.id);
      await releaseExecutionAgentBindings(engine, req.params.id);
      clearRebuiltSpecWorkflowPins(scopedStore, req.params.id);

      // Reset all steps to pending
      for (let i = 0; i < task.steps.length; i++) {
        if (task.steps[i].status !== "pending") {
          await scopedStore.updateStep(req.params.id, i, "pending");
        }
      }

      await scopedStore.updateTask(req.params.id, RESET_TASK_FIELDS);

      await scopedStore.logEntry(
        req.params.id,
        "Task reset by user — all progress cleared, fresh worktree and branch will be allocated",
      );

      await scopedStore.moveTask(req.params.id, "todo");
      clearRebuiltSpecWorkflowPins(scopedStore, req.params.id);
      let updated = await scopedStore.getTask(req.params.id);
      if (!updated) {
        throw notFound(`Task ${req.params.id} not found after reset`);
      }

      const needsDriftCorrection = updated.column !== "todo"
        || (updated.worktree ?? null) !== null
        || (updated.branch ?? null) !== null
        || (updated.checkedOutBy ?? null) !== null
        || (updated.executionStartedAt ?? null) !== null;

      if (needsDriftCorrection) {
        const offendingSnapshot = {
          column: updated.column,
          worktree: updated.worktree ?? null,
          branch: updated.branch ?? null,
          checkedOutBy: updated.checkedOutBy ?? null,
          executionStartedAt: updated.executionStartedAt ?? null,
          taskDoneRetryCount: updated.taskDoneRetryCount ?? null,
          worktreeSessionRetryCount: updated.worktreeSessionRetryCount ?? null,
          sessionFile: updated.sessionFile ?? null,
        };
        await scopedStore.updateTask(req.params.id, RESET_DRIFT_CORRECTION_FIELDS);
        await scopedStore.logEntry(
          req.params.id,
          "Auto-corrected reset drift after moveTask — normalized task back to todo with cleared worktree/branch bindings",
          JSON.stringify(offendingSnapshot),
        );
        await emitResetDriftAudit(scopedStore, req.params.id, offendingSnapshot);
        updated = await scopedStore.getTask(req.params.id);
        if (!updated) {
          throw notFound(`Task ${req.params.id} not found after reset drift correction`);
        }
      }

      if (updated.column !== "todo" || (updated.worktree ?? null) !== null || (updated.branch ?? null) !== null) {
        throw conflict(
          `Reset refused to return task ${req.params.id} in limbo state (${updated.column}, branch=${updated.branch ?? "null"}, worktree=${updated.worktree ?? "null"})`,
        );
      }

      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Duplicate task
  router.post("/tasks/:id/duplicate", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const newTask = await scopedStore.duplicateTask(req.params.id);
      res.status(201).json(newTask);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Create refinement task from a completed or in-review task
  router.post("/tasks/:id/refine", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { feedback } = req.body;
      if (!feedback || typeof feedback !== "string") {
        throw badRequest("feedback is required and must be a string");
      }
      // Trim before checking length to catch whitespace-only input
      const trimmedFeedback = feedback.trim();
      if (trimmedFeedback.length === 0 || trimmedFeedback.length > 2000) {
        throw badRequest("feedback must be between 1 and 2000 characters");
      }

      const refinedTask = await scopedStore.refineTask(req.params.id, trimmedFeedback);
      await scopedStore.logEntry(req.params.id, "Refinement requested", trimmedFeedback);
      res.status(201).json(refinedTask);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404
        : (err instanceof Error ? err.message : String(err)).includes("must be in 'done' or 'in-review'") ? 400
        : (err instanceof Error ? err.message : String(err)).includes("Feedback is required") ? 400
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Archive task (any live column → archived)
  router.post("/tasks/:id/archive", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const removeLineageReferences = req.query.removeLineageReferences === "1"
        || req.query.removeLineageReferences === "true";
      const task = await scopedStore.archiveTask(req.params.id, {
        cleanup: true,
        removeLineageReferences,
      });
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const isTaskHasLineageChildrenError =
        err instanceof Error
        && err.name === "TaskHasLineageChildrenError"
        && Array.isArray((err as { childIds?: unknown }).childIds);

      if (isTaskHasLineageChildrenError) {
        const childIds = (err as unknown as { childIds: string[] }).childIds;
        throw new ApiError(409, err instanceof Error ? err.message : "Task has lineage children", {
          code: "TASK_HAS_LINEAGE_CHILDREN",
          taskId: req.params.id,
          lineageChildIds: childIds,
        });
      }

      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("must be in") || message.includes("already archived") ? 400 : 500;
      throw new ApiError(status, message);
    }
  });

  // Unarchive task (archived → restored column)
  router.post("/tasks/:id/unarchive", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.unarchiveTask(req.params.id);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("must be in") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Archive all done tasks
  router.post("/tasks/archive-all-done", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const archived = await scopedStore.archiveAllDone();
      res.json({ archived });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/tasks/batch-update-models
   * Batch update AI model configuration for multiple tasks.
   * Body: { taskIds: string[], modelProvider?: string | null, modelId?: string | null, validatorModelProvider?: string | null, validatorModelId?: string | null, planningModelProvider?: string | null, planningModelId?: string | null }
   * Returns: { updated: Task[], count: number }
   */
  router.post("/tasks/batch-update-models", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const {
        taskIds,
        modelProvider,
        modelId,
        validatorModelProvider,
        validatorModelId,
        planningModelProvider,
        planningModelId,
        nodeId,
      } = req.body;

      // Validate taskIds
      if (!Array.isArray(taskIds)) {
        throw badRequest("taskIds must be an array");
      }
      if (taskIds.length === 0) {
        throw badRequest("taskIds must contain at least one task ID");
      }
      if (taskIds.some((id) => typeof id !== "string" || id.trim().length === 0)) {
        throw badRequest("taskIds must contain non-empty strings");
      }

      // Validate that at least one model field or node override is being updated
      const hasExecutorModel = modelProvider !== undefined || modelId !== undefined;
      const hasValidatorModel = validatorModelProvider !== undefined || validatorModelId !== undefined;
      const hasPlanningModel = planningModelProvider !== undefined || planningModelId !== undefined;
      const hasNodeId = nodeId !== undefined;
      if (!hasExecutorModel && !hasValidatorModel && !hasPlanningModel && !hasNodeId) {
        throw badRequest("At least one model field or nodeId must be provided");
      }

      if (nodeId !== undefined && nodeId !== null && typeof nodeId !== "string") {
        throw badRequest("nodeId must be a string, null, or undefined");
      }

      // Validate model field pairs (both provider and modelId must be provided together or neither)
      const validateModelPair = (provider: unknown, modelIdValue: unknown, name: string): { provider?: string | null; modelId?: string | null } => {
        if (provider === undefined && modelIdValue === undefined) {
          return { provider: undefined, modelId: undefined };
        }
        if ((provider !== undefined && modelIdValue === undefined) || (provider === undefined && modelIdValue !== undefined)) {
          throw new Error(`${name} must include both provider and modelId or neither`);
        }
        if (provider !== null && typeof provider !== "string") {
          throw new Error(`${name} provider must be a string or null`);
        }
        if (modelIdValue !== null && typeof modelIdValue !== "string") {
          throw new Error(`${name} modelId must be a string or null`);
        }
        return { provider: provider as string | null, modelId: modelIdValue as string | null };
      };

      let validatedExecutor: { provider?: string | null; modelId?: string | null };
      let validatedValidator: { provider?: string | null; modelId?: string | null };
      let validatedPlanning: { provider?: string | null; modelId?: string | null };

      try {
        validatedExecutor = validateModelPair(modelProvider, modelId, "Executor model");
        validatedValidator = validateModelPair(validatorModelProvider, validatorModelId, "Validator model");
        validatedPlanning = validateModelPair(planningModelProvider, planningModelId, "Planning model");
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          throw err;
        }
        throw badRequest(err instanceof Error ? err.message : String(err));
      }

      // Verify all tasks exist
      const tasksById = new Map<string, Awaited<ReturnType<TaskStore["getTask"]>>>();
      for (const taskId of taskIds) {
        try {
          const task = await scopedStore.getTask(taskId);
          tasksById.set(taskId, task);
        } catch (err: unknown) {
          if (err instanceof ApiError) {
            throw err;
          }
          if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err instanceof Error ? err.message : String(err)).includes("not found")) {
            throw notFound(`Task ${taskId} not found`);
          }
          throw err;
        }
      }

      // Build update payload (only include fields that were explicitly provided)
      const updates: {
        modelProvider?: string | null;
        modelId?: string | null;
        validatorModelProvider?: string | null;
        validatorModelId?: string | null;
        planningModelProvider?: string | null;
        planningModelId?: string | null;
        nodeId?: string | null;
      } = {};
      if (validatedExecutor.provider !== undefined) {
        updates.modelProvider = validatedExecutor.provider;
      }
      if (validatedExecutor.modelId !== undefined) {
        updates.modelId = validatedExecutor.modelId;
      }
      if (validatedValidator.provider !== undefined) {
        updates.validatorModelProvider = validatedValidator.provider;
      }
      if (validatedValidator.modelId !== undefined) {
        updates.validatorModelId = validatedValidator.modelId;
      }
      if (validatedPlanning.provider !== undefined) {
        updates.planningModelProvider = validatedPlanning.provider;
      }
      if (validatedPlanning.modelId !== undefined) {
        updates.planningModelId = validatedPlanning.modelId;
      }
      if (nodeId !== undefined) {
        updates.nodeId = nodeId;
      }

      // Update all tasks in parallel
      const updatePromises = taskIds.map(async (taskId) => {
        try {
          const updated = await scopedStore.updateTask(taskId, updates);
          return { success: true, task: updated };
        } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
          runtimeLogger.error(`Failed to update task ${taskId}`, {
            error: err instanceof Error ? err.message : String(err),
          });
          const success = false;
          return { success, taskId, error: err instanceof Error ? err.message : String(err) };
        }
      });

      const results = await Promise.all(updatePromises);

      // Collect successful updates
      const updated: Task[] = [];
      const errors: Array<{ taskId: string; error: string | undefined }> = [];

      for (const result of results) {
        if (result.success && "task" in result && result.task) {
          updated.push(result.task);
        } else if (!result.success) {
          errors.push({ taskId: result.taskId, error: result.error });
        }
      }

      // Log errors but don't fail the entire request
      if (errors.length > 0) {
        runtimeLogger.error(`${errors.length} tasks failed to update`, { errors });
      }

      res.json({ updated, count: updated.length });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to batch update models");
    }
  });

  // Upload attachment
  router.post("/tasks/:id/attachments", upload.single("file") as import("express").RequestHandler, async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      if (!req.file) {
        throw badRequest("No file provided");
      }
      const attachment = await scopedStore.addAttachment(
        req.params.id as string,
        req.file.originalname,
        req.file.buffer,
        req.file.mimetype,
      );
      res.status(201).json(attachment);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("Invalid mime type") || (err instanceof Error ? err.message : String(err)).includes("File too large") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Download attachment
  router.get("/tasks/:id/attachments/:filename", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { path, mimeType } = await scopedStore.getAttachment(req.params.id, req.params.filename);
      res.setHeader("Content-Type", mimeType);
      createReadStream(path).pipe(res);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Attachment not found");
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Delete attachment
  router.delete("/tasks/:id/attachments/:filename", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.deleteAttachment(req.params.id, req.params.filename);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Attachment not found");
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Get historical agent logs for a task.
  // Tool-oriented detail payloads may be clipped server-side to keep the
  // dashboard responsive when agents emit very large command results.
  // The 500-entry cap (MAX_LOG_ENTRIES) is still a client-side whole-list limit.
  // When limit is provided, includes X-Total-Count and X-Has-More headers for pagination.
  router.get("/tasks/:id/logs", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const limit = typeof req.query.limit === "string"
        ? Number.parseInt(req.query.limit, 10)
        : undefined;
      const offset = typeof req.query.offset === "string"
        ? Number.parseInt(req.query.offset, 10)
        : undefined;

      // Only include options object when we have explicit parameters
      const options: { limit?: number; offset?: number } | undefined =
        limit !== undefined && Number.isFinite(limit)
          ? { limit, ...(offset !== undefined && Number.isFinite(offset) ? { offset } : {}) }
          : undefined;

      const logs = await scopedStore.getAgentLogs(req.params.id, options);

      // Include pagination headers for bounded reads, including the initial page.
      // This enables the frontend to show Load More before an offset is present.
      if (limit !== undefined && Number.isFinite(limit)) {
        const total = await scopedStore.getAgentLogCount(req.params.id);
        res.setHeader("X-Total-Count", String(total));

        const effectiveOffset = offset !== undefined && Number.isFinite(offset) ? offset : 0;
        const hasMore = total > (effectiveOffset + logs.length);
        res.setHeader("X-Has-More", hasMore ? "true" : "false");
      }

      res.json(logs);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/tasks/:id/workflow-results
   * Get workflow step execution results for a task.
   * Returns: WorkflowStepResult[]
   */
  router.get("/tasks/:id/workflow-results", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      res.json(task.workflowStepResults || []);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  router.get("/tasks/stranded-refinements", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const rawFreshnessMinutes = req.query.freshnessMinutes;
      let freshnessThresholdMs: number | undefined;
      if (rawFreshnessMinutes !== undefined) {
        const value = Array.isArray(rawFreshnessMinutes) ? rawFreshnessMinutes[0] : rawFreshnessMinutes;
        const parsed = Number.parseInt(String(value), 10);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1440) {
          throw badRequest("freshnessMinutes must be a positive integer <= 1440");
        }
        freshnessThresholdMs = parsed * 60 * 1000;
      }

      const items = await scopedStore.listStrandedRefinements({ freshnessThresholdMs });
      res.json({
        items: items.map((item) => ({
          ...item,
          recommendation: strandedReasonRecommendation(item.reasons),
        })),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Get task-scoped settings with effective workflow-setting values overlaid.
  router.get("/tasks/:id/effective-settings", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const base = await scopedStore.getSettingsFast();
      const detailed = await resolveEffectiveSettingsDetailed(scopedStore, { id: req.params.id });
      /*
       * FNXC:ModelResolution 2026-06-27-10:52:
       * Task-detail model displays need the same task-scoped workflow model lanes as execution. This route overlays the task's workflow setting values onto getSettingsFast() so moved Execution/Reviewer/Planning lanes render instead of the base "Default" fallback.
       */
      res.json(applyWorkflowSettingsOverlay(base, detailed));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Get single task with prompt content
  router.get("/tasks/:id", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id, {
        activityLogLimit: TASK_DETAIL_ACTIVITY_LOG_LIMIT,
      });
      let enrichedTask = task;
      // FNXC:PlannerOversight 2026-07-05-00:00:
      // FN-7600: the Task Detail modal's Overseer/Nudge controls read
      // `plannerOverseerState` from the merged full-detail object, but this
      // detail route previously never attached it (only the list route did,
      // per FN-7531 above) — so opening the modal via fetchTaskDetail
      // (dependency chips, Documents view, logs, or the post-open detail
      // refetch) always lost the snapshot and the Nudge button showed the
      // periodic-observation disabled copy even when the overseer was
      // actively watching. Mirror the list-route contract exactly: best-
      // effort, never throws, and omits the key (not `null`) when the
      // accessor returns no active observation.
      try {
        const plannerOverseerState = engine?.getPlannerOverseerRuntimeSnapshot(task.id);
        if (plannerOverseerState) {
          enrichedTask = { ...task, plannerOverseerState };
        }
      } catch {
        // Planner-overseer-state enrichment is best-effort and must never
        // fail the task-detail load — fall through with the un-enriched task.
      }
      res.json(trimTaskDetailActivityLog(enrichedTask));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      // ENOENT means the task directory/file genuinely doesn't exist → 404.
      // Any other error (e.g. JSON parse failure from a concurrent partial write,
      // or a transient FS error) should surface as 500 so clients can retry.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /*
  FNXC:TaskPauseControls 2026-06-21-00:00:
  Agent-assigned tasks must remain manually recoverable from approval-gating and other pauses. The engine still owns automatic pauses recorded with pausedByAgentId, while pauseTask(id, false) clears pausedByAgentId and userPaused so a human unpause can resume dispatch.
  */
  // Pause task
  router.post("/tasks/:id/pause", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      await scopedStore.getTask(req.params.id);
      const updated = await scopedStore.pauseTask(req.params.id, true);
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Unpause task
  router.post("/tasks/:id/unpause", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      await scopedStore.getTask(req.params.id);
      const updated = await scopedStore.pauseTask(req.params.id, false);
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /*
  FNXC:PlannerOversight 2026-07-04-17:00:
  FN-7517 task-detail planner-overseer control endpoints. Nudge is
  guidance-only — it must NOT trigger merge/PR/destructive side effects; it
  reuses ProjectEngine.nudgeOverseerTask, which itself only ever posts a
  steering comment through the existing FN-7512 guidance channel and is
  gated by the FN-7514 human-control guard (user-paused / autoMerge:false
  human-review) plus the effective oversight level. Stop disables active
  oversight for this task (per-task override -> "off") via
  ProjectEngine.stopOverseerTask. Explain is a pure READ of the current
  overseer runtime state (watched stage, reason, last action, attempt
  count/limit) via ProjectEngine.explainOverseerTask — never mutates
  anything. All three degrade to a 200 "not applicable" style payload
  (rather than a 5xx) when the engine/overseer runtime is unavailable for
  this project, since a missing in-memory runtime is an expected
  (non-error) state, e.g. right after an engine restart.
  */
  router.post("/tasks/:id/overseer/nudge", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      await scopedStore.getTask(req.params.id);
      if (!engine) {
        return res.json({ applied: false, reason: "engine-unavailable" });
      }
      const result = await engine.nudgeOverseerTask(req.params.id);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.post("/tasks/:id/overseer/stop", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      await scopedStore.getTask(req.params.id);
      if (!engine) {
        return res.json({ applied: false, reason: "engine-unavailable" });
      }
      const result = await engine.stopOverseerTask(req.params.id);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.get("/tasks/:id/overseer/explain", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      await scopedStore.getTask(req.params.id);
      if (!engine) {
        return res.json({ snapshot: null });
      }
      const snapshot = engine.explainOverseerTask(req.params.id);
      res.json({ snapshot });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /*
  FNXC:PlannerOversight 2026-07-04-18:00:
  FN-7519 read-only intervention-timeline endpoint. Reuses the existing
  run-audit store via `getPlannerInterventionTimeline` (built on top of
  `TaskStore.getRunAuditEvents`) rather than a parallel audit store; never
  mutates state and returns an empty array (not an error) when the task has
  no recorded interventions. This is a pure READ path — FN-7520 owns wiring
  `recordPlannerIntervention` calls at overseer decision points.
  */
  router.get("/tasks/:id/overseer/interventions", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      await scopedStore.getTask(req.params.id);
      const entries = getPlannerInterventionTimeline(scopedStore, req.params.id);
      res.json({ entries });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.post("/tasks/:id/recover-branch-binding", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (!task) {
        throw notFound(`Task ${req.params.id} not found`);
      }
      if (task.column !== "in-review") {
        throw badRequest("Task must be in 'in-review' column to recover branch binding");
      }

      const selfHealingManager = _resolveSelfHealingManager(scopedStore);
      if (!selfHealingManager) {
        throw badRequest("Self-healing manager unavailable");
      }

      const result = await selfHealingManager.reconcileInReviewBranchRebind({
        includeTaskIds: new Set([task.id]),
      });
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Approve plan for a task in awaiting-approval status
  router.post("/tasks/:id/approve-plan", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);

      // Verify task is in triage column with awaiting-approval status
      if (task.column !== "triage") {
        throw badRequest("Task must be in 'triage' column to approve plan");
      }
      if (task.status !== "awaiting-approval") {
        throw badRequest("Task must have status 'awaiting-approval' to approve plan");
      }
      // FNXC:ReleaseAuthorizationGate 2026-07-04-22:30:
      // FN-6481 requires a release-class task to carry an explicit
      // "**Release Authorized By User:** yes" marker before it can dispatch.
      // FN-7559 parks such tasks with awaitingApprovalReason === "release-authorization"
      // (distinct from an ordinary manual plan-approval hold) and hides the
      // Approve/Reject Plan buttons in the dashboard UI, but a direct API call bypasses
      // that UI protection. Enforce the gate here too so no client can dispatch a
      // release-class task without the authorization marker.
      if (task.awaitingApprovalReason === "release-authorization") {
        throw badRequest(
          "This task is held for release authorization. Add the **Release Authorized By User:** yes marker to its PROMPT.md and resubmit the spec instead of approving the plan.",
        );
      }

      // Log the approval
      await scopedStore.logEntry(task.id, "Plan approved by user");

      /*
       * FNXC:PlanApproval 2026-07-04-22:41:
       * FN-7569 — persist a fingerprint of the exact PROMPT.md the operator just approved
       * so a later re-specification (replan, plan-review retry, self-healing rebound) that
       * produces the identical plan can skip re-parking at awaiting-approval. Read the
       * on-disk PROMPT.md directly (best-effort) since the task row does not always carry
       * full prompt text; a missing/unreadable file leaves the fingerprint unset and the
       * manual gate falls back to today's always-re-park behavior for this task.
       */
      let approvedPlanFingerprint: string | undefined;
      try {
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
        const promptText = await readFile(promptPath, "utf8");
        approvedPlanFingerprint = computePlanApprovalFingerprint(promptText);
      } catch {
        // No PROMPT.md to fingerprint (unusual for an awaiting-approval task) — leave unset.
      }

      // Move to todo and clear status
      const updated = await scopedStore.moveTask(task.id, "todo");
      await scopedStore.updateTask(task.id, {
        status: undefined,
        ...(approvedPlanFingerprint ? { approvedPlanFingerprint } : {}),
      });

      res.json({ ...updated, status: undefined, ...(approvedPlanFingerprint ? { approvedPlanFingerprint } : {}) });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Reject plan for a task in awaiting-approval status
  router.post("/tasks/:id/reject-plan", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);

      // Verify task is in triage column with awaiting-approval status
      if (task.column !== "triage") {
        throw badRequest("Task must be in 'triage' column to reject plan");
      }
      if (task.status !== "awaiting-approval") {
        throw badRequest("Task must have status 'awaiting-approval' to reject plan");
      }
      // FNXC:ReleaseAuthorizationGate 2026-07-04-22:30:
      // Mirror of the approve-plan guard above: a release-authorization hold
      // (FN-7559's awaitingApprovalReason discriminator) must not be rejectable
      // through the API either, since rejecting would wipe/regenerate the spec
      // without the operator ever acknowledging the FN-6481 authorization gate.
      if (task.awaitingApprovalReason === "release-authorization") {
        throw badRequest(
          "This task is held for release authorization. Add the **Release Authorized By User:** yes marker to its PROMPT.md and resubmit the spec instead of rejecting the plan.",
        );
      }

      // Log the rejection
      await scopedStore.logEntry(task.id, "Plan rejected by user", "Specification will be regenerated");

      // Clear status to return to normal triage state
      /*
       * FNXC:PlanApproval 2026-07-04-22:41:
       * FN-7569 — clear any previously-recorded approval fingerprint alongside the status
       * clear and PROMPT.md removal, so the regenerated plan is always treated as new and
       * requires fresh manual approval (it must never inherit the rejected plan's fingerprint).
       */
      await scopedStore.updateTask(task.id, { status: undefined, approvedPlanFingerprint: null });

      // Remove PROMPT.md to force regeneration
      const { rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
      await rm(promptPath, { force: true });

      const updated = await scopedStore.getTask(task.id);
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  const strandedReasonRecommendation = (reasons: string[]): string => {
    if (reasons.includes("awaiting-approval")) return "operator approval needed";
    if (reasons.includes("failed")) return "operator retry needed (failed)";
    if (reasons.includes("stuck-killed")) return "operator retry needed (stuck-killed)";
    if (reasons.includes("recovery-backoff")) return "safe to expedite (clear backoff)";
    return "safe to expedite";
  };

  router.get("/tasks/:id/stranded-refinement", async (req, res) => {
    try {
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (task.sourceType !== "task_refine") {
        throw badRequest("Task must have sourceType 'task_refine'");
      }
      if (task.column !== "triage") {
        throw badRequest("Task must be in 'triage' column");
      }

      const stranded = await scopedStore.listStrandedRefinements();
      const detail = stranded.find((item) => item.task.id === task.id) ?? {
        task,
        reasons: [] as string[],
        nextRecoveryAt: task.nextRecoveryAt,
        ageMs: Math.max(0, Date.now() - Date.parse(task.createdAt)),
      };

      const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
      const promptExists = existsSync(promptPath);
      const dependencyDetails = await Promise.all((task.dependencies ?? []).map(async (dependencyId) => {
        try {
          const depTask = await scopedStore.getTask(dependencyId);
          return { id: dependencyId, exists: true, column: depTask.column, done: depTask.column === "done" || depTask.column === "archived" };
        } catch {
          return { id: dependencyId, exists: false, done: false };
        }
      }));

      res.json({
        ...detail,
        recommendation: strandedReasonRecommendation(detail.reasons),
        promptExists,
        dependencies: {
          total: dependencyDetails.length,
          allExist: dependencyDetails.every((dep) => dep.exists),
          allResolved: dependencyDetails.every((dep) => dep.done),
          items: dependencyDetails,
        },
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  router.post("/tasks/:id/expedite-refinement", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (task.sourceType !== "task_refine") {
        throw badRequest("Task must have sourceType 'task_refine'");
      }
      if (task.column !== "triage") {
        throw badRequest("Task must be in 'triage' column");
      }
      if (task.paused) {
        throw badRequest("Paused refinements cannot be expedited");
      }

      if (task.status === "awaiting-approval") {
        await scopedStore.logEntry(task.id, "Expedite requested — operator action required", "approve-plan required");
        return res.json({ task, expedited: false, requiresOperatorAction: "approve-plan" });
      }
      if (task.status === "failed") {
        await scopedStore.logEntry(task.id, "Expedite requested — operator action required", "retry-failed required");
        return res.json({ task, expedited: false, requiresOperatorAction: "retry-failed" });
      }
      if (task.status === "stuck-killed") {
        await scopedStore.logEntry(task.id, "Expedite requested — operator action required", "retry-stuck required");
        return res.json({ task, expedited: false, requiresOperatorAction: "retry-stuck" });
      }

      const stranded = await scopedStore.listStrandedRefinements();
      const strandedEntry = stranded.find((item) => item.task.id === task.id);
      const hasExpediteLog = (task.log ?? []).some((entry) => entry.action === "Refinement expedited");
      const canExpedite = strandedEntry?.reasons.includes("untriaged-stale") || strandedEntry?.reasons.includes("recovery-backoff");

      if (hasExpediteLog && !task.nextRecoveryAt) {
        return res.json({ task, expedited: true, alreadyExpedited: true });
      }

      if (!canExpedite) {
        return res.json({ task, expedited: false, alreadyExpedited: false, reason: "not-stranded" });
      }

      const updated = await scopedStore.updateTask(task.id, {
        nextRecoveryAt: undefined,
      });
      await scopedStore.logEntry(task.id, "Refinement expedited", strandedEntry?.reasons.includes("recovery-backoff")
        ? "Cleared nextRecoveryAt"
        : "Expedite request recorded for stale refinement");

      res.json({
        task: updated,
        expedited: true,
        alreadyExpedited: hasExpediteLog && !task.nextRecoveryAt,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  router.get("/tasks/:id/comments", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      res.json(task.comments || []);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  router.post("/tasks/:id/comments", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { text, author } = req.body;
      if (!text || typeof text !== "string") {
        throw badRequest("text is required and must be a string");
      }
      if (text.length === 0 || text.length > 2000) {
        throw badRequest("text must be between 1 and 2000 characters");
      }
      if (author !== undefined && typeof author !== "string") {
        throw badRequest("author must be a string");
      }
      const normalizedAuthor = author?.trim() || "user";
      const task = await scopedStore.addTaskComment(req.params.id, text, normalizedAuthor);

      const newCommentId = task.comments?.at(-1)?.id;
      const wake = {
        triggeringCommentType: "task" as const,
        triggeringCommentIds: newCommentId ? [newCommentId] : undefined,
        triggerDetail: "task-comment",
      };
      if (normalizedAuthor === "user") {
        if (task.column === "in-review" && !task.sessionFile) {
          const { task: reengagedTask } = await reengageInReviewTaskForUserComment(scopedStore, task, wake);
          res.json(reengagedTask);
          return;
        }

        void triggerCommentWakeForAssignedAgent(scopedStore, task, wake).catch((error) => {
          runtimeLogger.warn(
            `failed to trigger task-comment heartbeat for ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }

      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  router.patch("/tasks/:id/comments/:commentId", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { text } = req.body;
      if (!text || typeof text !== "string") {
        throw badRequest("text is required and must be a string");
      }
      if (text.length === 0 || text.length > 2000) {
        throw badRequest("text must be between 1 and 2000 characters");
      }
      const task = await scopedStore.updateTaskComment(req.params.id, req.params.commentId, text);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404
        : (err instanceof Error ? err.message : String(err)).includes("not found") ? 404
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  router.delete("/tasks/:id/comments/:commentId", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.deleteTaskComment(req.params.id, req.params.commentId);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404
        : (err instanceof Error ? err.message : String(err)).includes("not found") ? 404
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // ── Task Document Routes ──────────────────────────────────────────────────

  // Key validation regex: alphanumeric, hyphens, underscores, 1-64 chars
  const DOCUMENT_KEY_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

  // GET /tasks/:id/documents — List all documents for a task
  router.get("/tasks/:id/documents", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const documents = await scopedStore.getTaskDocuments(req.params.id);
      res.json(documents);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // GET /tasks/:id/documents/:key — Get latest revision of a specific document
  router.get("/tasks/:id/documents/:key", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const document = await scopedStore.getTaskDocument(req.params.id, req.params.key);
      if (!document) {
        throw new ApiError(404, "Document not found");
      }
      res.json(document);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // GET /tasks/:id/documents/:key/revisions — List all revisions for a document
  router.get("/tasks/:id/documents/:key/revisions", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const revisions = await scopedStore.getTaskDocumentRevisions(req.params.id, req.params.key);
      res.json(revisions);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      // Return empty array if document doesn't exist (not an error)
      res.json([]);
    }
  });

  // PUT /tasks/:id/documents/:key — Create or update a document (optimistic revision)
  router.put("/tasks/:id/documents/:key", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);

      // Validate key format
      if (!DOCUMENT_KEY_REGEX.test(req.params.key)) {
        throw badRequest("Invalid document key. Must be 1-64 alphanumeric characters, hyphens, or underscores.");
      }

      const { content, author, metadata } = req.body;

      // Validate content
      if (content === undefined || content === null) {
        throw badRequest("content is required");
      }
      if (typeof content !== "string") {
        throw badRequest("content must be a string");
      }
      if (content.length < 1 || content.length > 100000) {
        throw badRequest("content must be between 1 and 100000 characters");
      }

      // Validate author (optional, defaults to "user")
      if (author !== undefined && typeof author !== "string") {
        throw badRequest("author must be a string");
      }

      // Validate metadata (optional)
      if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))) {
        throw badRequest("metadata must be an object");
      }

      const document = await scopedStore.upsertTaskDocument(req.params.id, {
        key: req.params.key,
        content,
        author: author?.trim() || "user",
        metadata: metadata as Record<string, unknown> | undefined,
      });

      // Return 201 for new documents (revision === 1), 200 for updates
      const status = document.revision === 1 ? 201 : 200;
      res.status(status).json(document);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // DELETE /tasks/:id/documents/:key — Delete a document and all its revisions
  router.delete("/tasks/:id/documents/:key", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      await scopedStore.deleteTaskDocument(req.params.id, req.params.key);
      res.status(204).send();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found") ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * FNXC:ArtifactRegistry 2026-06-21-04:46:
   * Documents view needs a cross-agent registry read surface for all artifact media classes. Keep query validation aligned with `/documents` so dashboard tabs share bounded pagination behavior while rejecting unknown artifact types before store access.
   */
  router.get("/artifacts", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const {
        type: typeParam,
        authorId,
        taskId,
        q,
        limit: limitStr,
        offset: offsetStr,
      } = req.query as Record<string, string | undefined>;

      let type: ArtifactType | undefined;
      if (typeParam !== undefined) {
        if (!isArtifactType(typeParam)) {
          throw badRequest("type must be one of: document, image, video, audio, other");
        }
        type = typeParam;
      }

      let limit = 200;
      if (limitStr !== undefined) {
        const parsed = parseInt(limitStr, 10);
        if (isNaN(parsed) || parsed < 1) {
          throw badRequest("limit must be a positive integer");
        }
        limit = Math.min(parsed, 1000);
      }

      let offset = 0;
      if (offsetStr !== undefined) {
        const parsed = parseInt(offsetStr, 10);
        if (isNaN(parsed) || parsed < 0) {
          throw badRequest("offset must be a non-negative integer");
        }
        offset = parsed;
      }

      const artifacts = await scopedStore.listArtifacts({
        type,
        authorId,
        taskId,
        search: q,
        limit,
        offset,
      });

      res.json(artifacts);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(500, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * FNXC:ArtifactRegistry 2026-06-21-04:46:
   * Media artifacts stream by registry id with the persisted MIME type so images, video, and audio render inline in the Documents gallery. Binary rows are anchored under either a task `artifacts/` directory or the task-less `.fusion/artifacts/` registry; inline text rows return their content directly because they intentionally have no file uri.
   */
  router.get("/artifacts/:id/media", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const artifact = await scopedStore.getArtifact(req.params.id);
      if (!artifact) {
        throw notFound("Artifact not found");
      }

      if (!artifact.uri) {
        if (artifact.content === undefined) {
          throw notFound("Artifact media not found");
        }
        res.setHeader("Content-Type", artifact.mimeType ?? "text/plain; charset=utf-8");
        res.send(artifact.content);
        return;
      }

      const mediaPath = resolveArtifactMediaPath(scopedStore, artifact);
      if (!mediaPath) {
        throw notFound("Artifact media not found");
      }

      const stream = createReadStream(mediaPath);
      stream.on("error", () => {
        if (!res.headersSent) {
          res.status(404).json({ error: "Artifact media not found" });
        } else {
          res.end();
        }
      });
      res.setHeader("Content-Type", artifact.mimeType ?? "application/octet-stream");
      stream.pipe(res);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(500, err instanceof Error ? err.message : String(err));
    }
  });

  // GET /documents — List all documents across all tasks
  router.get("/documents", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);

      // Parse query parameters
      const { q, limit: limitStr, offset: offsetStr } = req.query as Record<string, string | undefined>;

      // Validate limit
      let limit = 200;
      if (limitStr !== undefined) {
        const parsed = parseInt(limitStr, 10);
        if (isNaN(parsed) || parsed < 1) {
          throw badRequest("limit must be a positive integer");
        }
        limit = Math.min(parsed, 1000);
      }

      // Validate offset
      let offset = 0;
      if (offsetStr !== undefined) {
        const parsed = parseInt(offsetStr, 10);
        if (isNaN(parsed) || parsed < 0) {
          throw badRequest("offset must be a non-negative integer");
        }
        offset = parsed;
      }

      const documents = await scopedStore.getAllDocuments({
        searchQuery: q,
        limit,
        offset,
      });

      res.json(documents);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(500, err instanceof Error ? err.message : String(err));
    }
  });

  // Add steering comment to task
  router.post("/tasks/:id/steer", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { text } = req.body;
      if (!text || typeof text !== "string") {
        throw badRequest("text is required and must be a string");
      }
      if (text.length === 0 || text.length > 2000) {
        throw badRequest("text must be between 1 and 2000 characters");
      }
      const task = await scopedStore.addSteeringComment(req.params.id, text, "user");

      const newSteeringCommentId = task.steeringComments?.at(-1)?.id;
      const wake = {
        triggeringCommentType: "steering" as const,
        triggeringCommentIds: newSteeringCommentId ? [newSteeringCommentId] : undefined,
        triggerDetail: "steering-comment",
      };
      if (task.column === "in-review" && !task.sessionFile) {
        const { task: reengagedTask } = await reengageInReviewTaskForUserComment(scopedStore, task, wake);
        res.json(reengagedTask);
        return;
      }

      void triggerCommentWakeForAssignedAgent(scopedStore, task, wake).catch((error) => {
        runtimeLogger.warn(
          `failed to trigger steering-comment heartbeat for ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Request AI revision of task spec
  router.post("/tasks/:id/spec/revise", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { feedback } = req.body;
      if (!feedback || typeof feedback !== "string") {
        throw badRequest("feedback is required and must be a string");
      }
      if (feedback.length === 0 || feedback.length > 2000) {
        throw badRequest("feedback must be between 1 and 2000 characters");
      }

      // Get current task state
      const task = await scopedStore.getTask(req.params.id);

      // If task is already in triage, skip the transition check and moveTask.
      // Just reset for replanning in place.
      if (task.column === "triage") {
        // Log the revision request
        await scopedStore.logEntry(task.id, "AI spec revision requested", feedback);

        // Remove the existing spec so replanning starts from the task
        // description and feedback rather than revising stale PROMPT.md content.
        const { rm } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
        await rm(promptPath, { force: true });

        // Update status to indicate needs replanning
        await scopedStore.updateTask(task.id, { status: "needs-replan" });

        const updated = await scopedStore.getTask(task.id);
        res.json(updated);
        return;
      }

      // Check if task can transition to triage
      // #1403: task.column is ColumnId; VALID_TRANSITIONS is keyed by the legacy
      // closed union. A non-legacy custom column id has no legacy transition row,
      // so it correctly resolves to "cannot transition" here.
      const canTransition =
        isColumn(task.column) && VALID_TRANSITIONS[task.column].includes("triage");
      if (!canTransition) {
        throw badRequest(
          `Cannot request spec revision for tasks in '${task.column}' column. Move task to 'todo' or 'in-progress' first.`,
        );
      }

      // Log the revision request
      await scopedStore.logEntry(task.id, "AI spec revision requested", feedback);

      // Move to triage for replanning
      const updated = await scopedStore.moveTask(task.id, "triage");

      // Remove the existing spec so replanning starts from the task
      // description and feedback rather than revising stale PROMPT.md content.
      const { rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
      await rm(promptPath, { force: true });

      // Update status to indicate needs replanning
      await scopedStore.updateTask(task.id, { status: "needs-replan" });

      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404
        : (err instanceof Error ? err.message : String(err)).includes("Invalid transition") ? 400
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Rebuild task spec without feedback
  router.post("/tasks/:id/spec/rebuild", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);

      // Get current task state
      const task = await scopedStore.getTask(req.params.id);

      // If task is already in triage, skip the transition check and moveTask.
      // Just reset for replanning in place.
      if (task.column === "triage") {
        // Log the rebuild request
        await scopedStore.logEntry(task.id, "Specification rebuild requested by user");
        clearRebuiltSpecWorkflowPins(scopedStore, task.id);

        // Remove the existing spec so rebuilds produce a fresh PROMPT.md instead
        // of asking triage to revise whatever was already on disk.
        const { rm } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
        await rm(promptPath, { force: true });

        // Update status to indicate needs replanning
        await scopedStore.updateTask(task.id, { status: "needs-replan" });

        const updated = await scopedStore.getTask(task.id);
        res.json(updated);
        return;
      }

      // Check if task can transition to triage
      // #1403: task.column is ColumnId; VALID_TRANSITIONS is keyed by the legacy
      // closed union. A non-legacy custom column id has no legacy transition row,
      // so it correctly resolves to "cannot transition" here.
      const canTransition =
        isColumn(task.column) && VALID_TRANSITIONS[task.column].includes("triage");
      if (!canTransition) {
        throw badRequest(`Cannot rebuild spec for tasks in '${task.column}' column. Move task to a valid column first.`);
      }

      // Log the rebuild request
      await scopedStore.logEntry(task.id, "Specification rebuild requested by user");
      clearRebuiltSpecWorkflowPins(scopedStore, task.id);

      // Move to triage for replanning
      const updated = await scopedStore.moveTask(task.id, "triage");

      // Remove the existing spec so rebuilds produce a fresh PROMPT.md instead
      // of asking triage to revise whatever was already on disk.
      const { rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
      await rm(promptPath, { force: true });

      // Update status to indicate needs replanning
      await scopedStore.updateTask(task.id, { status: "needs-replan" });

      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404
        : (err instanceof Error ? err.message : String(err)).includes("Invalid transition") ? 400
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  router.post("/tasks/:id/repair-overlap-blocker", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      /*
      FNXC:OverlapRepair 2026-06-25-04:34:
      This route can clear scheduler-visible blockers. Reject non-object JSON bodies before calling the store so malformed requests cannot accidentally run a real repair with every option undefined.
      */
      const body = req.body ?? {};
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw badRequest("body must be an object");
      }
      const { dryRun, reason } = body as { dryRun?: unknown; reason?: unknown };
      if (dryRun !== undefined && typeof dryRun !== "boolean") {
        throw badRequest("dryRun must be a boolean");
      }
      if (reason !== undefined && reason !== null && typeof reason !== "string") {
        throw badRequest("reason must be a string");
      }
      if (typeof scopedStore.repairOverlapBlocker !== "function") {
        throw new ApiError(501, "Overlap blocker repair is unavailable for this store");
      }
      const result = await scopedStore.repairOverlapBlocker(req.params.id, {
        dryRun,
        ...(typeof reason === "string" && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
      });
      if (result.reason === "task-not-found") {
        throw notFound(result.message);
      }
      if (!result.repaired && !result.dryRun) {
        const status = result.reason === "no-overlap-blocker" ? 400 : 409;
        throw new ApiError(status, result.message);
      }
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(500, err instanceof Error ? err.message : String(err));
    }
  });

  // Update task
  router.patch("/tasks/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { title, description, prompt, priority, dependencies, enabledWorkflowSteps, modelProvider, modelId, validatorModelProvider, validatorModelId, planningModelProvider, planningModelId, thinkingLevel, assigneeUserId, reviewLevel, executionMode, sourceIssue, nodeId, branch, baseBranch, githubTracking, gitlabTracking, noCommitsExpected, autoMerge, overlapBlockedBy, status, dismissNearDuplicate } = req.body;
      const hasBodyField = (field: string) => Object.prototype.hasOwnProperty.call(req.body, field);

      // Validate model fields are strings or undefined/null
      const validateModelField = (value: unknown, name: string): string | null | undefined => {
        if (value === undefined) return undefined;
        if (value === null) return null;
        if (typeof value !== "string") {
          throw new Error(`${name} must be a string`);
        }
        return value;
      };

      const validatedModelProvider = validateModelField(modelProvider, "modelProvider");
      const validatedModelId = validateModelField(modelId, "modelId");
      const validatedValidatorModelProvider = validateModelField(validatorModelProvider, "validatorModelProvider");
      const validatedValidatorModelId = validateModelField(validatorModelId, "validatorModelId");
      const validatedPlanningModelProvider = validateModelField(planningModelProvider, "planningModelProvider");
      const validatedPlanningModelId = validateModelField(planningModelId, "planningModelId");
      const validatedAssigneeUserId = validateModelField(assigneeUserId, "assigneeUserId");

      // Validate thinkingLevel if provided
      const validThinkingLevels = [...THINKING_LEVELS];
      if (thinkingLevel !== undefined && thinkingLevel !== null && !validThinkingLevels.includes(thinkingLevel)) {
        throw new Error(`thinkingLevel must be one of: ${validThinkingLevels.join(", ")}`);
      }

      // Validate reviewLevel if provided (must be integer 0-3)
      if (reviewLevel !== undefined && reviewLevel !== null) {
        if (typeof reviewLevel !== "number" || !Number.isInteger(reviewLevel) || reviewLevel < 0 || reviewLevel > 3) {
          throw new Error("reviewLevel must be an integer between 0 and 3");
        }
      }

      // Validate executionMode if provided (must be "standard" or "fast")
      const validExecutionModes = ["standard", "fast"];
      if (executionMode !== undefined && executionMode !== null && !validExecutionModes.includes(executionMode)) {
        throw new Error(`executionMode must be one of: ${validExecutionModes.join(", ")}`);
      }

      // Validate priority if provided. `null` resets to the default (`normal`)
      // via store.updateTask's null-handling.
      if (priority !== undefined && priority !== null && !isTaskPriority(priority)) {
        throw new Error(`priority must be one of: ${TASK_PRIORITIES.join(", ")}`);
      }

      if (enabledWorkflowSteps !== undefined) {
        if (!Array.isArray(enabledWorkflowSteps) || !enabledWorkflowSteps.every((id: unknown) => typeof id === "string")) {
          throw new Error("enabledWorkflowSteps must be an array of strings");
        }
      }

      if (hasBodyField("noCommitsExpected") && noCommitsExpected !== undefined && typeof noCommitsExpected !== "boolean") {
        throw new Error("noCommitsExpected must be a boolean");
      }

      if (hasBodyField("autoMerge") && autoMerge !== undefined && autoMerge !== null && typeof autoMerge !== "boolean") {
        throw new Error("autoMerge must be a boolean");
      }

      let validatedSourceIssue: import("@fusion/core").TaskSourceIssue | null | undefined;
      if (hasBodyField("sourceIssue")) {
        if (sourceIssue === null) {
          validatedSourceIssue = null;
        } else if (sourceIssue === undefined) {
          validatedSourceIssue = undefined;
        } else if (typeof sourceIssue === "object") {
          const candidate = sourceIssue as {
            provider?: unknown;
            repository?: unknown;
            externalIssueId?: unknown;
            issueNumber?: unknown;
            url?: unknown;
          };

          if (typeof candidate.provider !== "string" || candidate.provider.trim().length === 0) {
            throw new Error("sourceIssue.provider must be a non-empty string");
          }
          if (typeof candidate.repository !== "string" || candidate.repository.trim().length === 0) {
            throw new Error("sourceIssue.repository must be a non-empty string");
          }
          if (typeof candidate.externalIssueId !== "string" || candidate.externalIssueId.trim().length === 0) {
            throw new Error("sourceIssue.externalIssueId must be a non-empty string");
          }
          if (typeof candidate.issueNumber !== "number" || !Number.isFinite(candidate.issueNumber) || !Number.isInteger(candidate.issueNumber) || candidate.issueNumber <= 0) {
            throw new Error("sourceIssue.issueNumber must be a positive integer");
          }
          if (candidate.url !== undefined && candidate.url !== null && typeof candidate.url !== "string") {
            throw new Error("sourceIssue.url must be a string when provided");
          }

          validatedSourceIssue = {
            provider: candidate.provider.trim(),
            repository: candidate.repository.trim(),
            externalIssueId: candidate.externalIssueId.trim(),
            issueNumber: candidate.issueNumber,
            ...(typeof candidate.url === "string" && candidate.url.trim().length > 0 ? { url: candidate.url.trim() } : {}),
          };
        } else {
          throw new Error("sourceIssue must be an object or null");
        }
      }

      let validatedNodeId: string | null | undefined;
      if (hasBodyField("nodeId")) {
        if (nodeId === undefined) {
          validatedNodeId = undefined;
        } else if (nodeId === null) {
          validatedNodeId = null;
        } else if (typeof nodeId === "string") {
          const trimmed = nodeId.trim();
          if (trimmed.length === 0) {
            throw new Error("nodeId must be a non-empty string");
          }
          validatedNodeId = trimmed;
        } else {
          throw new Error("nodeId must be a string or null");
        }
      }

      const validatePatchBranchField = (value: unknown, fieldName: string): string | null | undefined => {
        if (value === undefined) return undefined;
        if (value === null) return null;
        if (typeof value !== "string") {
          throw new Error(`${fieldName} must be a string or null`);
        }
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
      };

      const normalizedBranch = hasBodyField("branch") ? validatePatchBranchField(branch, "branch") : undefined;
      const normalizedBaseBranch = hasBodyField("baseBranch") ? validatePatchBranchField(baseBranch, "baseBranch") : undefined;

      let validatedGithubTracking: { enabled?: boolean; repoOverride?: string | null; issue?: null } | null | undefined;
      if (hasBodyField("githubTracking")) {
        if (githubTracking === null) {
          validatedGithubTracking = null;
        } else if (typeof githubTracking !== "object") {
          throw new Error("githubTracking must be an object or null");
        } else {
          const candidate = githubTracking as { enabled?: unknown; repoOverride?: unknown; issue?: unknown };
          if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") {
            throw new Error("githubTracking.enabled must be a boolean");
          }
          if (candidate.repoOverride !== undefined && candidate.repoOverride !== null && typeof candidate.repoOverride !== "string") {
            throw new Error("githubTracking.repoOverride must be a string or null");
          }
          if (typeof candidate.repoOverride === "string") {
            const trimmed = candidate.repoOverride.trim();
            if (trimmed.length > 0 && !REPO_OVERRIDE_RE.test(trimmed)) {
              throw badRequest("githubTracking.repoOverride must be in 'owner/repo' format");
            }
          }
          if (candidate.issue !== undefined && candidate.issue !== null) {
            throw new Error("githubTracking.issue only supports null for manual unlink");
          }

          const trimmedRepo = typeof candidate.repoOverride === "string" ? candidate.repoOverride.trim() : candidate.repoOverride;
          validatedGithubTracking = {
            ...(candidate.enabled !== undefined ? { enabled: candidate.enabled } : {}),
            ...(candidate.repoOverride !== undefined ? { repoOverride: typeof trimmedRepo === "string" ? (trimmedRepo.length > 0 ? trimmedRepo : null) : null } : {}),
            ...(candidate.issue === null ? { issue: null } : {}),
          };
        }
      }

      let validatedGitLabTracking: (Omit<import("@fusion/core").TaskGitLabTracking, "item"> & { item?: import("@fusion/core").TaskGitLabTrackedItem | null }) | null | undefined;
      if (hasBodyField("gitlabTracking")) {
        if (gitlabTracking === null) {
          validatedGitLabTracking = null;
        } else if (typeof gitlabTracking !== "object" || Array.isArray(gitlabTracking)) {
          throw new Error("gitlabTracking must be an object or null");
        } else {
          const candidate = gitlabTracking as { item?: unknown; unlinkedAt?: unknown };
          if (candidate.unlinkedAt !== undefined && candidate.unlinkedAt !== null && typeof candidate.unlinkedAt !== "string") {
            throw new Error("gitlabTracking.unlinkedAt must be a string when provided");
          }
          if (candidate.item === null) {
            validatedGitLabTracking = { item: null };
          } else if (candidate.item === undefined) {
            validatedGitLabTracking = {
              ...(typeof candidate.unlinkedAt === "string" && candidate.unlinkedAt.trim().length > 0 ? { unlinkedAt: candidate.unlinkedAt.trim() } : {}),
            };
          } else if (typeof candidate.item !== "object" || Array.isArray(candidate.item)) {
            throw new Error("gitlabTracking.item must be an object or null");
          } else {
            const item = candidate.item as Record<string, unknown>;
            const kind = item.kind;
            if (kind !== "project_issue" && kind !== "group_issue" && kind !== "merge_request") {
              throw new Error("gitlabTracking.item.kind must be project_issue, group_issue, or merge_request");
            }
            if (typeof item.url !== "string" || item.url.trim().length === 0) {
              throw new Error("gitlabTracking.item.url must be a non-empty string");
            }
            if (typeof item.instanceUrl !== "string" || item.instanceUrl.trim().length === 0) {
              throw new Error("gitlabTracking.item.instanceUrl must be a non-empty string");
            }
            let parsedUrl: URL;
            let parsedInstanceUrl: URL;
            try {
              parsedUrl = new URL(item.url.trim());
              parsedInstanceUrl = new URL(item.instanceUrl.trim());
            } catch {
              throw new Error("gitlabTracking.item.url and instanceUrl must be valid URLs");
            }
            if (!["http:", "https:"].includes(parsedUrl.protocol) || !["http:", "https:"].includes(parsedInstanceUrl.protocol)) {
              throw new Error("gitlabTracking.item.url and instanceUrl must be http(s) URLs");
            }
            if (typeof item.host !== "string" || item.host.trim().length === 0) {
              throw new Error("gitlabTracking.item.host must be a non-empty string");
            }
            if (item.host.trim() !== parsedUrl.host || parsedInstanceUrl.host !== parsedUrl.host) {
              throw new Error("gitlabTracking.item.host must match the GitLab URL host");
            }
            if (typeof item.iid !== "number" || !Number.isInteger(item.iid) || item.iid <= 0) {
              throw new Error("gitlabTracking.item.iid must be a positive integer");
            }
            const optionalNumberFields = ["id", "projectId"];
            for (const field of optionalNumberFields) {
              if (item[field] !== undefined && item[field] !== null && (typeof item[field] !== "number" || !Number.isInteger(item[field]) || Number(item[field]) <= 0)) {
                throw new Error(`gitlabTracking.item.${field} must be a positive integer when provided`);
              }
            }
            const optionalStringFields = ["projectPath", "groupPath", "title", "state", "createdAt", "linkedAt", "lastSyncedAt", "staleAt", "staleReason"];
            for (const field of optionalStringFields) {
              if (item[field] !== undefined && item[field] !== null && typeof item[field] !== "string") {
                throw new Error(`gitlabTracking.item.${field} must be a string when provided`);
              }
            }
            if (typeof item.createdAt !== "string" || item.createdAt.trim().length === 0) {
              throw new Error("gitlabTracking.item.createdAt must be a non-empty string");
            }
            if (item.groupId !== undefined && item.groupId !== null) {
              const groupIdType = typeof item.groupId;
              if (!((groupIdType === "string" && String(item.groupId).trim().length > 0) || (groupIdType === "number" && Number.isInteger(item.groupId) && Number(item.groupId) > 0))) {
                throw new Error("gitlabTracking.item.groupId must be a non-empty string or positive integer when provided");
              }
            }

            validatedGitLabTracking = {
              item: {
                kind,
                url: parsedUrl.toString(),
                instanceUrl: parsedInstanceUrl.origin,
                host: parsedUrl.host,
                iid: item.iid,
                ...(typeof item.id === "number" ? { id: item.id } : {}),
                ...(typeof item.projectId === "number" ? { projectId: item.projectId } : {}),
                ...(typeof item.projectPath === "string" && item.projectPath.trim().length > 0 ? { projectPath: item.projectPath.trim() } : {}),
                ...(typeof item.groupId === "number" || typeof item.groupId === "string" ? { groupId: typeof item.groupId === "string" ? item.groupId.trim() : item.groupId } : {}),
                ...(typeof item.groupPath === "string" && item.groupPath.trim().length > 0 ? { groupPath: item.groupPath.trim() } : {}),
                ...(typeof item.title === "string" && item.title.trim().length > 0 ? { title: item.title.trim() } : {}),
                ...(typeof item.state === "string" && item.state.trim().length > 0 ? { state: item.state.trim() } : {}),
                createdAt: item.createdAt.trim(),
                ...(typeof item.linkedAt === "string" && item.linkedAt.trim().length > 0 ? { linkedAt: item.linkedAt.trim() } : {}),
                ...(typeof item.lastSyncedAt === "string" && item.lastSyncedAt.trim().length > 0 ? { lastSyncedAt: item.lastSyncedAt.trim() } : {}),
                ...(typeof item.staleAt === "string" && item.staleAt.trim().length > 0 ? { staleAt: item.staleAt.trim() } : {}),
                ...(typeof item.staleReason === "string" && item.staleReason.trim().length > 0 ? { staleReason: item.staleReason.trim() } : {}),
              },
              ...(typeof candidate.unlinkedAt === "string" && candidate.unlinkedAt.trim().length > 0 ? { unlinkedAt: candidate.unlinkedAt.trim() } : {}),
            };
          }
        }
      }

      let validatedOverlapBlockedBy: string | null | undefined;
      if (hasBodyField("overlapBlockedBy")) {
        if (overlapBlockedBy === null || overlapBlockedBy === undefined) {
          validatedOverlapBlockedBy = overlapBlockedBy;
        } else if (typeof overlapBlockedBy === "string") {
          const trimmed = overlapBlockedBy.trim();
          if (trimmed.length === 0) {
            throw new Error("overlapBlockedBy must be a string or null");
          }
          validatedOverlapBlockedBy = trimmed;
        } else {
          throw new Error("overlapBlockedBy must be a string or null");
        }
      }

      let validatedStatus: null | undefined;
      if (hasBodyField("status")) {
        if (status !== null) {
          throw new Error("status may only be cleared via this endpoint (must be null)");
        }
        validatedStatus = null;
      }

      if (hasBodyField("dismissNearDuplicate") && dismissNearDuplicate !== undefined && typeof dismissNearDuplicate !== "boolean") {
        throw new Error("dismissNearDuplicate must be a boolean");
      }

      const updates: Parameters<typeof scopedStore.updateTask>[1] = {};
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (prompt !== undefined) updates.prompt = prompt;
      if (hasBodyField("priority")) updates.priority = priority;
      if (dependencies !== undefined) updates.dependencies = dependencies;
      if (enabledWorkflowSteps !== undefined) updates.enabledWorkflowSteps = enabledWorkflowSteps;
      if (hasBodyField("noCommitsExpected")) updates.noCommitsExpected = noCommitsExpected;
      if (hasBodyField("autoMerge")) updates.autoMerge = autoMerge === null ? undefined : autoMerge;
      if (hasBodyField("modelProvider")) updates.modelProvider = validatedModelProvider;
      if (hasBodyField("modelId")) updates.modelId = validatedModelId;
      if (hasBodyField("validatorModelProvider")) updates.validatorModelProvider = validatedValidatorModelProvider;
      if (hasBodyField("validatorModelId")) updates.validatorModelId = validatedValidatorModelId;
      if (hasBodyField("planningModelProvider")) updates.planningModelProvider = validatedPlanningModelProvider;
      if (hasBodyField("planningModelId")) updates.planningModelId = validatedPlanningModelId;
      if (hasBodyField("thinkingLevel")) updates.thinkingLevel = thinkingLevel === null ? null : thinkingLevel;
      if (hasBodyField("assigneeUserId")) updates.assigneeUserId = validatedAssigneeUserId;
      if (hasBodyField("reviewLevel")) updates.reviewLevel = reviewLevel;
      if (hasBodyField("executionMode")) updates.executionMode = executionMode === null ? null : executionMode;
      if (hasBodyField("sourceIssue")) updates.sourceIssue = validatedSourceIssue === undefined ? undefined : validatedSourceIssue;
      if (hasBodyField("nodeId")) updates.nodeId = validatedNodeId;
      if (hasBodyField("branch")) updates.branch = normalizedBranch;
      if (hasBodyField("baseBranch")) updates.baseBranch = normalizedBaseBranch;
      if (hasBodyField("githubTracking")) {
        (updates as Record<string, unknown>).githubTracking = validatedGithubTracking;
      }
      if (hasBodyField("gitlabTracking")) {
        (updates as Record<string, unknown>).gitlabTracking = validatedGitLabTracking;
      }
      if (hasBodyField("overlapBlockedBy")) updates.overlapBlockedBy = validatedOverlapBlockedBy;
      if (hasBodyField("status")) updates.status = validatedStatus;
      if (dismissNearDuplicate === true) {
        updates.sourceMetadataPatch = { nearDuplicateDismissed: true };
      }

      if (hasBodyField("nodeId") && validatedNodeId !== undefined) {
        const currentTask = await scopedStore.getTask(req.params.id);
        if (!currentTask) {
          throw notFound("Task not found");
        }
        const validation = validateNodeOverrideChange(currentTask, validatedNodeId ?? null);
        if (!validation.allowed) {
          throw new ApiError(409, validation.message ?? "Node override change blocked");
        }
      }

      const task = await scopedStore.updateTask(req.params.id, updates);

      const manualUnlinkRequested =
        hasBodyField("githubTracking") &&
        validatedGithubTracking !== null &&
        typeof validatedGithubTracking === "object" &&
        validatedGithubTracking.issue === null;
      const disableRequested =
        hasBodyField("githubTracking") &&
        validatedGithubTracking !== null &&
        typeof validatedGithubTracking === "object" &&
        validatedGithubTracking.enabled === false;
      const shouldAttemptTrackingIssueCreate =
        !manualUnlinkRequested &&
        !disableRequested &&
        task.githubTracking?.enabled === true &&
        !task.githubTracking?.issue;

      if (shouldAttemptTrackingIssueCreate) {
        await createTrackingIssueForTask(scopedStore, task, { githubToken: options?.githubToken });
        const refreshedTask = await scopedStore.getTask(req.params.id, {
          activityLogLimit: TASK_DETAIL_ACTIVITY_LOG_LIMIT,
        });
        res.json(trimTaskDetailActivityLog(refreshedTask));
        return;
      }

      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("must be a string") || (err instanceof Error ? err.message : String(err)).includes("must be a non-empty string") || (err instanceof Error ? err.message : String(err)).includes("must be a string or null") || (err instanceof Error ? err.message : String(err)).includes("must be an array of strings") || (err instanceof Error ? err.message : String(err)).includes("must be a boolean") || (err instanceof Error ? err.message : String(err)).includes("thinkingLevel must be one of") || (err instanceof Error ? err.message : String(err)).includes("reviewLevel must be an integer") || (err instanceof Error ? err.message : String(err)).includes("executionMode must be one of") || (err instanceof Error ? err.message : String(err)).includes("priority must be one of") || (err instanceof Error ? err.message : String(err)).includes("sourceIssue") || (err instanceof Error ? err.message : String(err)).includes("gitlabTracking") || (err instanceof Error ? err.message : String(err)).includes("status may only be cleared") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Assign or unassign a task to an explicit agent
  router.patch("/tasks/:id/assign", async (req, res) => {
    try {
      const { agentId, override } = req.body as { agentId?: string | null; override?: boolean };
      if (agentId !== null && typeof agentId !== "string") {
        throw badRequest("agentId must be a string or null");
      }
      if (typeof agentId === "string" && agentId.trim().length === 0) {
        throw badRequest("agentId must be a non-empty string or null");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      if (typeof agentId === "string") {
        const agent = await agentStore.getAgent(agentId);
        if (!agent) {
          throw notFound("Agent not found");
        }

        const targetTask = await scopedStore.getTask(req.params.id);
        if (!targetTask) {
          throw notFound("Task not found");
        }

        if (override !== true && !canAgentTakeImplementationTaskForExplicitRouting(agent, targetTask)) {
          throw new ApiError(409, formatRoleMismatchReason(agent, targetTask));
        }
      }

      const task = await scopedStore.updateTask(req.params.id, {
        assignedAgentId: agentId === null ? null : agentId,
      });
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Assign or unassign a task to a user (for review handoff)
  router.patch("/tasks/:id/assign-user", async (req, res) => {
    try {
      const { userId } = req.body as { userId?: string | null };
      if (userId !== null && typeof userId !== "string") {
        throw badRequest("userId must be a string or null");
      }
      if (typeof userId === "string" && userId.trim().length === 0) {
        throw badRequest("userId must be a non-empty string or null");
      }

      const { store: scopedStore } = await getProjectContext(req);

      // When assigning a user, also clear the awaiting-user-review status
      // so the task can proceed to merge
      const updates: Record<string, unknown> = {
        assigneeUserId: userId === null ? null : userId,
      };

      // Clear awaiting-user-review status when explicitly assigning a user
      if (userId !== null) {
        updates.status = null;
      }

      const task = await scopedStore.updateTask(req.params.id, updates as Parameters<typeof scopedStore.updateTask>[1]);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Patch a task's custom field values (U13/KTD-14). Delegates to the single
  // store write authority (`updateTaskCustomFields`), which validates the patch
  // against the task's workflow field schema. A typed rejection surfaces as a
  // 400 carrying `{ fieldId, code, detail }` so the dashboard can render an
  // inline per-field error. `null`/`undefined` values delete the field.
  router.patch("/tasks/:id/custom-fields", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const body = req.body as { customFields?: unknown };
      const patch = body?.customFields;
      if (patch === undefined || patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        throw badRequest("customFields must be an object");
      }

      const storeWithFields = scopedStore as TaskStore & {
        updateTaskCustomFields?: (
          taskId: string,
          patch: Record<string, unknown>,
        ) => Promise<{ ok: true; task: Task } | { ok: false; rejection: { code: string; fieldId: string; detail: string } }>;
      };
      if (typeof storeWithFields.updateTaskCustomFields !== "function") {
        throw notFound("custom fields unavailable");
      }

      const result = await storeWithFields.updateTaskCustomFields(
        req.params.id,
        patch as Record<string, unknown>,
      );
      if (!result.ok) {
        throw new ApiError(400, result.rejection.detail, {
          fieldId: result.rejection.fieldId,
          code: result.rejection.code,
          detail: result.rejection.detail,
        });
      }
      res.json(result.task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  // Accept review - clear assignee and awaiting-user-review status, keep in in-review
  router.post("/tasks/:id/accept-review", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);

      // Clear assignee and status to allow auto-merge to proceed
      const task = await scopedStore.updateTask(req.params.id, {
        assigneeUserId: null,
        status: null,
      });
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  router.get("/tasks/:id/review", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      let reviewData: TaskReviewData;

      if (task.prInfo) {
        const badgeParsed = parseGitHubBadgeUrl(task.prInfo.url);
        const repoInfo = getCurrentRepo(scopedStore.getRootDir());
        const owner = badgeParsed?.owner ?? repoInfo?.owner;
        const repo = badgeParsed?.repo ?? repoInfo?.repo;
        if (!owner || !repo) {
          throw badRequest("Could not determine GitHub repository for PR review fetch");
        }
        reviewData = await new GitHubClient(options?.githubToken ?? process.env.GITHUB_TOKEN).getPrReviewDetails(owner, repo, task.prInfo.number);
      } else {
        reviewData = await buildDirectTaskReviewData(task, scopedStore);
      }

      res.json(reviewData);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      }
      rethrowAsApiError(err);
    }
  });

  router.post("/tasks/:id/review/refresh", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      let reviewData: TaskReviewData;
      if (task.prInfo) {
        const badgeParsed = parseGitHubBadgeUrl(task.prInfo.url);
        const repoInfo = getCurrentRepo(scopedStore.getRootDir());
        const owner = badgeParsed?.owner ?? repoInfo?.owner;
        const repo = badgeParsed?.repo ?? repoInfo?.repo;
        if (!owner || !repo) {
          throw badRequest("Could not determine GitHub repository for PR review refresh");
        }
        reviewData = await new GitHubClient(options?.githubToken ?? process.env.GITHUB_TOKEN).getPrReviewDetails(owner, repo, task.prInfo.number);
      } else {
        reviewData = await buildDirectTaskReviewData(task, scopedStore);
      }
      res.json(reviewData);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      }
      rethrowAsApiError(err);
    }
  });

  // Queue same-task revision pass for selected review items
  router.post("/tasks/:id/review/address", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);

      type SelectedReviewItem = {
        id: string;
        source: "pr-review" | "reviewer-agent";
        threadId?: string;
        filePath?: string;
        lineNumber?: number;
        author?: string;
        summary: string;
        body: string;
        url?: string;
      };

      const selectedItems: SelectedReviewItem[] = Array.isArray(req.body?.selectedItems)
        ? req.body.selectedItems.filter((value: unknown): value is SelectedReviewItem => {
            if (!value || typeof value !== "object") return false;
            const item = value as Record<string, unknown>;
            return typeof item.id === "string" && item.id.trim().length > 0 && typeof item.summary === "string" && typeof item.body === "string";
          })
        : [];

      if (selectedItems.length === 0) {
        throw badRequest("selectedItems must be a non-empty array of review items");
      }
      const unsupportedSource = selectedItems.find((item) => item.source !== "pr-review" && item.source !== "reviewer-agent");
      if (unsupportedSource) {
        throw badRequest(`Unsupported review source: ${String(unsupportedSource.source)}`);
      }
      let canonicalReviewData: TaskReviewData;
      if (task.prInfo) {
        const badgeParsed = parseGitHubBadgeUrl(task.prInfo.url);
        const repoInfo = getCurrentRepo(scopedStore.getRootDir());
        const owner = badgeParsed?.owner ?? repoInfo?.owner;
        const repo = badgeParsed?.repo ?? repoInfo?.repo;
        if (!owner || !repo) {
          throw badRequest("Could not determine GitHub repository for PR review fetch");
        }
        canonicalReviewData = await new GitHubClient(options?.githubToken ?? process.env.GITHUB_TOKEN).getPrReviewDetails(owner, repo, task.prInfo.number);
      } else {
        canonicalReviewData = await buildDirectTaskReviewData(task, scopedStore);
      }

      const canonicalReviewItems = canonicalReviewData.items.map((item) => ({
        id: item.itemId,
        body: item.body,
        summary: item.title,
        author: { login: item.author },
        createdAt: item.createdAt ?? canonicalReviewData.fetchedAt ?? new Date(0).toISOString(),
        updatedAt: item.updatedAt ?? undefined,
        path: item.filePath,
        line: item.line,
        threadId: item.threadId,
        htmlUrl: item.url,
        state: item.reviewState ?? undefined,
        isResolved: item.isResolved,
        source: item.sourceMode === "reviewer-agent" ? "reviewer-agent" as const : "github-pr" as const,
      }));
      const reviewState = {
        source: canonicalReviewData.mode,
        summary: canonicalReviewData.summary ?? task.reviewState?.summary,
        items: canonicalReviewItems,
        addressing: task.reviewState?.addressing ?? [],
        lastRefreshedAt: task.reviewState?.lastRefreshedAt ?? canonicalReviewData.fetchedAt ?? undefined,
        refreshSource: task.reviewState?.refreshSource,
        refreshStatus: task.reviewState?.refreshStatus,
        refreshError: task.reviewState?.refreshError,
      } satisfies NonNullable<Task["reviewState"]>;

      /*
      FNXC:TaskReview 2026-06-27-00:00:
      Revision validation must use the same canonical review source the UI renders. Reviewer-agent ids come from buildReviewerAgentItemId via buildDirectTaskReviewData, not from persisted reviewState.items, because direct executor review addressing persists only addressing snapshots.
      */
      const now = new Date().toISOString();
      const selectedSet = new Set(selectedItems.map((item: SelectedReviewItem) => item.id));
      const canonicalIds = new Set(reviewState.items.map((item) => item.id));
      const expectedSource = canonicalReviewData.mode === "pull-request" ? "pr-review" : "reviewer-agent";
      const reviewSourceMismatch = selectedItems.find((item) => canonicalIds.has(item.id) && item.source !== expectedSource);
      if (reviewSourceMismatch) {
        throw badRequest("Selected review source does not match task review mode");
      }
      const hasUnknownSelection = selectedItems.some((item) => !canonicalIds.has(item.id));
      if (hasUnknownSelection) {
        throw badRequest("selectedItems must reference existing review items");
      }

      const modeSummary = `${reviewState.source === "pull-request" ? "pull-request" : "reviewer-agent"} · ${selectedItems.length} selected item(s)`;
      const steeringItems = selectedItems.map((item: SelectedReviewItem, index: number) => {
        const location = item.filePath ? `${item.filePath}${typeof item.lineNumber === "number" ? `:${item.lineNumber}` : ""}` : undefined;
        const snippetSource = item.body.trim() || item.summary.trim();
        const snippet = snippetSource.length > 220 ? `${snippetSource.slice(0, 220)}…` : snippetSource;
        const urlSuffix = item.url ? ` | url: ${item.url}` : "";
        return `${index + 1}. source: ${item.source}${location ? ` | location: ${location}` : ""} | "${snippet}"${urlSuffix}`;
      });
      const steeringText = ["Selected review feedback to address", modeSummary, ...steeringItems].join("\n");

      const priorAddressingById = new Map(reviewState.addressing.map((record) => [record.itemId, record] as const));
      const nextAddressing = [
        ...reviewState.addressing.filter((record) => !selectedSet.has(record.itemId)),
        ...selectedItems.map((item: SelectedReviewItem) => {
          const existing = priorAddressingById.get(item.id);
          return {
            itemId: item.id,
            status: "queued" as const,
            selectedAt: now,
            startedAt: undefined,
            completedAt: undefined,
            error: undefined,
            stale: false,
            snapshot: {
              itemId: item.id,
              sourceMode: reviewState.source,
              source: item.source,
              summary: item.summary,
              body: item.body,
              authorLogin: item.author,
              filePath: item.filePath,
              lineNumber: item.lineNumber,
              threadId: item.threadId,
              url: item.url,
            },
            ...(existing ? { startedAt: existing.startedAt, completedAt: existing.completedAt } : {}),
          };
        }),
      ];

      const nextReviewState = {
        ...reviewState,
        addressing: nextAddressing,
      };

      await scopedStore.updateTask(task.id, { reviewState: nextReviewState });

      let steeringCommentId: string | null = null;
      const steeringComment = await scopedStore.addSteeringComment(task.id, steeringText, "user");
      steeringCommentId = steeringComment.id;

      let updatedTask: Task = await scopedStore.getTask(task.id);

      if (task.column === "in-review") {
        updatedTask = (await reengageInReviewTaskForUserComment(scopedStore, updatedTask, {
          triggeringCommentType: "steering",
          triggeringCommentIds: steeringCommentId ? [steeringCommentId] : undefined,
          triggerDetail: "review-address",
        })).task;
      } else {
        const hasActiveSession = Boolean(updatedTask.sessionFile);
        if (steeringCommentId && updatedTask.column === "in-progress" && updatedTask.assignedAgentId && !hasActiveSession) {
          await triggerCommentWakeForAssignedAgent(scopedStore, updatedTask, {
            triggeringCommentType: "steering",
            triggeringCommentIds: [steeringCommentId],
            triggerDetail: "review-address",
          });
        }
      }

      await scopedStore.logEntry(task.id, "Same-task review revision requested", `${selectedItems.length} item(s) submitted from review tab`);
      res.json({ task: updatedTask, reviewState: nextReviewState });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  router.post("/tasks/:id/pr/address-feedback", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      const prInfo = task.prInfo ?? task.prInfos?.[0];
      if (!prInfo) {
        throw badRequest("Task must have a linked pull request before PR feedback can be addressed");
      }
      if (task.column !== "in-review" && task.column !== "in-progress") {
        throw badRequest("PR feedback can only be addressed for in-review or in-progress tasks");
      }

      /*
      FNXC:TaskReview 2026-06-28-00:00:
      The manual Address PR feedback route must seed only Fusion-authored instructions plus PR identity. PR review text is untrusted and stays data fetched by ce-resolve-pr-feedback, so this lifecycle trigger cannot execute reviewer-provided directives while waking the assigned agent.

      FNXC:TaskReview 2026-06-28-16:39:
      The route response and dashboard toasts say an AI session started. Reject unsupported columns before writing steering/log entries so todo, done, and archived tasks cannot report success while no session is scheduled.
      */
      const prLabel = `PR #${prInfo.number}`;
      const steeringText = [
        ADDRESS_PR_FEEDBACK_PROMPT,
        "If the compound-engineering skill is unavailable, inspect the linked pull request, evaluate each unresolved review thread, fix valid issues, reply with what changed or why no change was made, and resolve threads that are fully addressed.",
        `Context: ${prLabel} ${prInfo.url}`,
      ].join("\n\n");

      const steeringComment = await scopedStore.addSteeringComment(task.id, steeringText, "user");
      const steeringCommentId = steeringComment.id;

      let updatedTask: Task = await scopedStore.getTask(task.id);

      if (task.column === "in-review") {
        await scopedStore.updateTask(task.id, {
          status: null,
          error: null,
          sessionFile: null,
        });
        const lastDoneStep = [...task.steps]
          .map((step, index) => ({ step, index }))
          .reverse()
          .find(({ step }) => step.status === "done" || step.status === "in-progress");
        if (lastDoneStep) {
          await scopedStore.updateStep(task.id, lastDoneStep.index, "pending");
        }
        updatedTask = await scopedStore.moveTask(task.id, "in-progress", { preserveProgress: true });
      }

      const hasActiveSession = Boolean(updatedTask.sessionFile);
      if (updatedTask.column === "in-progress" && updatedTask.assignedAgentId && !hasActiveSession) {
        await triggerCommentWakeForAssignedAgent(scopedStore, updatedTask, {
          triggeringCommentType: "steering",
          triggeringCommentIds: [steeringCommentId],
          triggerDetail: "pr-address-feedback",
        });
      }

      await scopedStore.logEntry(task.id, "Address PR feedback requested", `${prLabel} queued via ce-resolve-pr-feedback skill prompt`);
      res.json({ task: updatedTask });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Return task to agent - clear assignee and status, move to todo
  router.post("/tasks/:id/return-to-agent", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);

      // Clear assignee and status, move to todo so scheduler re-dispatches
      await scopedStore.updateTask(req.params.id, {
        assigneeUserId: null,
        status: null,
      });
      const task = await scopedStore.moveTask(req.params.id, "todo");
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Acquire checkout lease for a task
  router.post("/tasks/:id/checkout", async (req, res) => {
    try {
      const { agentId } = req.body ?? {};
      if (typeof agentId !== "string" || agentId.trim().length === 0) {
        throw badRequest("agentId is required");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({
        rootDir: scopedStore.getFusionDir(),
        taskStore: scopedStore,
      });
      await agentStore.init();

      const task = await agentStore.checkoutTask(agentId, req.params.id);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "CheckoutConflictError") {
        const checkoutErr = err as Error & { currentHolderId?: string; taskId?: string };
        res.status(409).json({
          error: "Task is already checked out",
          currentHolder: checkoutErr.currentHolderId,
          taskId: checkoutErr.taskId,
        });
        return;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  // Release checkout lease for a task
  router.post("/tasks/:id/release", async (req, res) => {
    try {
      const { agentId } = req.body ?? {};
      if (typeof agentId !== "string" || agentId.trim().length === 0) {
        throw badRequest("agentId is required");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({
        rootDir: scopedStore.getFusionDir(),
        taskStore: scopedStore,
      });
      await agentStore.init();

      const task = await agentStore.releaseTask(agentId, req.params.id);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not the checkout holder")) {
        throw new ApiError(403, "Not the checkout holder");
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  // Force release checkout lease for a task
  router.post("/tasks/:id/force-release", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({
        rootDir: scopedStore.getFusionDir(),
        taskStore: scopedStore,
      });
      await agentStore.init();

      const task = await agentStore.forceReleaseTask(req.params.id);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  // Get checkout lease state for a task
  router.get("/tasks/:id/checkout", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (!task) {
        throw notFound("Task not found");
      }

      res.json({
        checkedOutBy: task.checkedOutBy ?? null,
        checkedOutAt: task.checkedOutAt ?? null,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Delete task
  router.delete("/tasks/:id", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      const removeDependencyReferences = req.query.removeDependencyReferences === "1"
        || req.query.removeDependencyReferences === "true";
      const removeLineageReferences = req.query.removeLineageReferences === "1"
        || req.query.removeLineageReferences === "true";
      const githubIssueActionRaw = req.query.githubIssueAction;
      const allowResurrection = req.query.allowResurrection === "1"
        || req.query.allowResurrection === "true";
      const githubIssueActionValues: readonly GithubIssueAction[] = ["close", "delete", "leave", "auto"];
      let githubIssueAction: GithubIssueAction | undefined;
      if (typeof githubIssueActionRaw === "string") {
        if (!githubIssueActionValues.includes(githubIssueActionRaw as GithubIssueAction)) {
          throw badRequest("githubIssueAction must be one of: close, delete, leave, auto");
        }
        githubIssueAction = githubIssueActionRaw as GithubIssueAction;
      }
      const task = await scopedStore.deleteTask(req.params.id, {
        removeDependencyReferences,
        removeLineageReferences,
        allowResurrection,
        githubIssueAction,
        auditContext: {
          agentId: "system",
          runId: `synthetic-dashboard-delete-${req.params.id}-${Date.now()}`,
        },
      });
      await releaseExecutionAgentBindings(engine, req.params.id);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const isTaskHasDependentsError =
        err instanceof Error
        && err.name === "TaskHasDependentsError"
        && Array.isArray((err as { dependentIds?: unknown }).dependentIds);

      if (isTaskHasDependentsError) {
        const dependentIds = (err as unknown as { dependentIds: string[] }).dependentIds;
        throw new ApiError(409, err instanceof Error ? err.message : "Task has dependents", {
          code: "TASK_HAS_DEPENDENTS",
          taskId: req.params.id,
          dependentIds,
        });
      }

      const isTaskHasLineageChildrenError =
        err instanceof Error
        && err.name === "TaskHasLineageChildrenError"
        && Array.isArray((err as { childIds?: unknown }).childIds);

      if (isTaskHasLineageChildrenError) {
        const childIds = (err as unknown as { childIds: string[] }).childIds;
        throw new ApiError(409, err instanceof Error ? err.message : "Task has lineage children", {
          code: "TASK_HAS_LINEAGE_CHILDREN",
          taskId: req.params.id,
          lineageChildIds: childIds,
        });
      }

      rethrowAsApiError(err);
    }
  });


}
