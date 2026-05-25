import { createReadStream } from "node:fs";
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
} from "@fusion/core";
import {
  COLUMNS,
  TASK_PRIORITIES,
  VALID_TRANSITIONS,
  computeContentFingerprint,
  isTaskPriority,
  REPO_OVERRIDE_RE,
  resolveTitleSummarizerSettingsModel,
  validateNodeOverrideChange,
  canAgentTakeImplementationTaskForExplicitRouting,
  formatRoleMismatchReason,
  getCurrentRepo,
  findDuplicateMatches,
  deterministicGuardLocks,
  runDeterministicDuplicateGuard,
  buildManualRetryResetPatch,
  reconcileDeterministicDuplicate,
  extractIntentSignature,
  findNearDuplicates,
  isEphemeralAgent,
  parseExplicitDuplicateMarker,
  type NearDuplicateCandidate,
} from "@fusion/core";
import { GitHubClient } from "../github.js";
import { createTrackingIssueForTask } from "../github-tracking-hook.js";
import { parseGitHubBadgeUrl } from "./register-git-github.js";
import { planTaskWorktreePath } from "@fusion/engine";
import type { RunAuditEventInput } from "@fusion/core";
import { ApiError, badRequest, conflict, notFound } from "../api-error.js";
import type { ApiRoutesContext } from "./types.js";
import { resolveBranchSelection } from "./branch-selection.js";

const REVIEW_BLOCK_RE = /##\s+(Code|Plan)\s+Review:[\s\S]*?(?=\n##\s+(?:Code|Plan)\s+Review:|$)/gi;
const REVIEW_VERDICT_RE = /###\s+Verdict:\s*(APPROVE|REVISE|RETHINK|UNAVAILABLE)\b/i;
const REVIEW_STEP_RE = /^(plan|code) review Step (\d+): (APPROVE|REVISE|RETHINK|UNAVAILABLE)\b/i;
const DUPLICATE_STOPWORDS = new Set(["a", "an", "the", "and", "or", "of", "to", "for", "in", "is", "on", "with", "fn"]);

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
      const { store: scopedStore } = await getProjectContext(req);
      const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
      const offset = typeof req.query.offset === "string" ? Number.parseInt(req.query.offset, 10) : undefined;
      const q = typeof req.query.q === "string" ? req.query.q.trim() : undefined;
      const includeArchived = req.query.includeArchived === "1" || req.query.includeArchived === "true";

      if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
        throw badRequest("limit must be a non-negative integer");
      }

      if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
        throw badRequest("offset must be a non-negative integer");
      }

      let tasks;
      if (q && q.length > 0) {
        tasks = await scopedStore.searchTasks(q, { limit, offset, slim: true, includeArchived });
      } else {
        // Board-view list: omit the heavy agent log payload and exclude
        // archived tasks unless explicitly requested. Full task detail still loads via
        // GET /api/tasks/:id. Without this, every dashboard load shipped tens of MB of agent logs.
        tasks = await scopedStore.listTasks({ limit, offset, slim: true, includeArchived });
      }
      res.json(tasks);
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
      const validThinkingLevels = ["off", "minimal", "low", "medium", "high"];
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

      const { branch: normalizedBranch, baseBranch: normalizedBaseBranch } =
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

      const deterministicReconcile = await reconcileDeterministicDuplicate(scopedStore, {
        createdTask: task,
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
              taskId: task.id,
              taskTitle: task.title,
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

        res.status(201).json(task);
        return;
      } finally {
        deterministicGuard.releaseLock();
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("must be a string") || (err instanceof Error ? err.message : String(err)).includes("must be an array of strings") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
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
      const status = (err instanceof Error ? err.message : String(err)).includes("Invalid transition") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
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

  // Retry failed, stuck-killed, or stranded triage/planning task
  router.post("/tasks/:id/retry", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      const retrySpecification =
        task.column === "triage" &&
        (task.status === "failed" ||
          task.status === "planning" ||
          task.status === "needs-replan" ||
          (task.stuckKillCount ?? 0) > 0);
      const isInReviewRetry =
        task.column === "in-review" &&
        (task.status === "failed" || task.status === "stuck-killed");
      if (task.status !== "failed" && task.status !== "stuck-killed" && !retrySpecification) {
        throw badRequest(`Task is not in a retryable state (current status: ${task.status || 'none'})`);
      }

      // In-review retry: distinguish between execution failures (incomplete steps)
      // and merge failures (all steps done).
      if (isInReviewRetry) {
        const hasIncompleteSteps = task.steps.some(
          (s: { status: string }) => s.status === "pending" || s.status === "in-progress",
        );
        // FN-4130 / PR #59 follow-up: zero-step review failures with no merge attempts
        // (`mergeRetries ?? 0 === 0`) failed during execution, not merge finalization.
        const isExecutionFailureInReview =
          hasIncompleteSteps || (task.steps.length === 0 && (task.mergeRetries ?? 0) === 0);

        if (isExecutionFailureInReview) {
          await scopedStore.updateTask(req.params.id, {
            status: null,
            error: null,
            ...buildManualRetryResetPatch(),
          });
          await scopedStore.logEntry(
            req.params.id,
            "Retry requested from dashboard (execution failure in-review → todo, preserving progress)",
          );
          const updated = await scopedStore.moveTask(req.params.id, "todo", { preserveProgress: true });
          res.json(updated);
          return;
        }

        await scopedStore.updateTask(req.params.id, {
          status: null,
          error: null,
          ...buildManualRetryResetPatch({ resetMergeRetries: true }),
        });
        await scopedStore.logEntry(req.params.id, "Retry requested from dashboard (in-review merge retry, mergeRetries reset)");
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
      await releaseExecutionAgentBindings(engine, req.params.id);
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
      // Fire github tracking explicitly so duplicates created through the
      // route (which may not pass through TaskStore.createTask's hook
      // invocation in mocked test setups) still produce a tracking issue
      // when the source task had tracking enabled. Best-effort.
      try {
        await createTrackingIssueForTask(scopedStore, newTask, { githubToken: options?.githubToken });
      } catch {
        // never block duplicate response
      }
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
      // Fire github tracking explicitly so refinements get a tracking issue
      // when the source task had tracking enabled. Best-effort.
      try {
        await createTrackingIssueForTask(scopedStore, refinedTask, { githubToken: options?.githubToken });
      } catch {
        // never block refine response
      }
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

  // Archive task (done → archived)
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

      const status = (err instanceof Error ? err.message : String(err)).includes("must be in") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Unarchive task (archived → done)
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

  // Get single task with prompt content
  router.get("/tasks/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id, {
        activityLogLimit: TASK_DETAIL_ACTIVITY_LOG_LIMIT,
      });
      res.json(trimTaskDetailActivityLog(task));
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

  // Pause task
  router.post("/tasks/:id/pause", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (task.assignedAgentId) {
        throw conflict(`Cannot manually pause/unpause task assigned to agent ${task.assignedAgentId}. Use agent pause controls instead.`);
      }
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
      const task = await scopedStore.getTask(req.params.id);
      if (task.assignedAgentId) {
        throw conflict(`Cannot manually pause/unpause task assigned to agent ${task.assignedAgentId}. Use agent pause controls instead.`);
      }
      const updated = await scopedStore.pauseTask(req.params.id, false);
      res.json(updated);
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

      // Log the approval
      await scopedStore.logEntry(task.id, "Plan approved by user");

      // Move to todo and clear status
      const updated = await scopedStore.moveTask(task.id, "todo");
      await scopedStore.updateTask(task.id, { status: undefined });

      res.json({ ...updated, status: undefined });
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

      // Log the rejection
      await scopedStore.logEntry(task.id, "Plan rejected by user", "Specification will be regenerated");

      // Clear status to return to normal triage state
      await scopedStore.updateTask(task.id, { status: undefined });

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
      const task = await scopedStore.addTaskComment(req.params.id, text, author?.trim() || "user");

      const newCommentId = task.comments?.at(-1)?.id;
      void triggerCommentWakeForAssignedAgent(scopedStore, task, {
        triggeringCommentType: "task",
        triggeringCommentIds: newCommentId ? [newCommentId] : undefined,
        triggerDetail: "task-comment",
      }).catch((error) => {
        runtimeLogger.warn(
          `failed to trigger task-comment heartbeat for ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
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
      void triggerCommentWakeForAssignedAgent(scopedStore, task, {
        triggeringCommentType: "steering",
        triggeringCommentIds: newSteeringCommentId ? [newSteeringCommentId] : undefined,
        triggerDetail: "steering-comment",
      }).catch((error) => {
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
      const canTransition = VALID_TRANSITIONS[task.column]?.includes("triage");
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
      const canTransition = VALID_TRANSITIONS[task.column]?.includes("triage");
      if (!canTransition) {
        throw badRequest(`Cannot rebuild spec for tasks in '${task.column}' column. Move task to a valid column first.`);
      }

      // Log the rebuild request
      await scopedStore.logEntry(task.id, "Specification rebuild requested by user");

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

  // Update task
  router.patch("/tasks/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { title, description, prompt, priority, dependencies, enabledWorkflowSteps, modelProvider, modelId, validatorModelProvider, validatorModelId, planningModelProvider, planningModelId, thinkingLevel, assigneeUserId, reviewLevel, executionMode, sourceIssue, nodeId, branch, baseBranch, githubTracking, noCommitsExpected, overlapBlockedBy, status } = req.body;
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
      const validThinkingLevels = ["off", "minimal", "low", "medium", "high"];
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

      const updates: Parameters<typeof scopedStore.updateTask>[1] = {};
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (prompt !== undefined) updates.prompt = prompt;
      if (hasBodyField("priority")) updates.priority = priority;
      if (dependencies !== undefined) updates.dependencies = dependencies;
      if (enabledWorkflowSteps !== undefined) updates.enabledWorkflowSteps = enabledWorkflowSteps;
      if (hasBodyField("noCommitsExpected")) updates.noCommitsExpected = noCommitsExpected;
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
      if (hasBodyField("overlapBlockedBy")) updates.overlapBlockedBy = validatedOverlapBlockedBy;
      if (hasBodyField("status")) updates.status = validatedStatus;

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
      const status = (err instanceof Error ? err.message : String(err)).includes("must be a string") || (err instanceof Error ? err.message : String(err)).includes("must be a non-empty string") || (err instanceof Error ? err.message : String(err)).includes("must be a string or null") || (err instanceof Error ? err.message : String(err)).includes("must be an array of strings") || (err instanceof Error ? err.message : String(err)).includes("must be a boolean") || (err instanceof Error ? err.message : String(err)).includes("thinkingLevel must be one of") || (err instanceof Error ? err.message : String(err)).includes("reviewLevel must be an integer") || (err instanceof Error ? err.message : String(err)).includes("executionMode must be one of") || (err instanceof Error ? err.message : String(err)).includes("priority must be one of") || (err instanceof Error ? err.message : String(err)).includes("sourceIssue") || (err instanceof Error ? err.message : String(err)).includes("status may only be cleared") ? 400 : 500;
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
      if (!task.reviewState) {
        throw badRequest("Task has no reviewState payload");
      }

      const now = new Date().toISOString();
      const selectedSet = new Set(selectedItems.map((item: SelectedReviewItem) => item.id));
      const sourceById = new Map(selectedItems.map((item: SelectedReviewItem) => [item.id, item.source] as const));
      const reviewSourceMismatch = task.reviewState.items.find((item: NonNullable<typeof task.reviewState>["items"][number]) => {
        const selectedSource = sourceById.get(item.id);
        if (!selectedSource || !task.reviewState) return false;
        const expectedSource = task.reviewState.source === "pull-request" ? "pr-review" : "reviewer-agent";
        return selectedSource !== expectedSource;
      });
      if (reviewSourceMismatch) {
        throw badRequest("Selected review source does not match task review mode");
      }
      const matchedItems = task.reviewState.items.filter((item: NonNullable<typeof task.reviewState>["items"][number]) => selectedSet.has(item.id));
      if (matchedItems.length !== selectedSet.size) {
        throw badRequest("selectedItems must reference existing review items");
      }

      const modeSummary = `${task.reviewState.source === "pull-request" ? "pull-request" : "reviewer-agent"} · ${selectedItems.length} selected item(s)`;
      const steeringItems = selectedItems.map((item: SelectedReviewItem, index: number) => {
        const location = item.filePath ? `${item.filePath}${typeof item.lineNumber === "number" ? `:${item.lineNumber}` : ""}` : undefined;
        const snippetSource = item.body.trim() || item.summary.trim();
        const snippet = snippetSource.length > 220 ? `${snippetSource.slice(0, 220)}…` : snippetSource;
        const urlSuffix = item.url ? ` | url: ${item.url}` : "";
        return `${index + 1}. source: ${item.source}${location ? ` | location: ${location}` : ""} | "${snippet}"${urlSuffix}`;
      });
      const steeringText = ["Selected review feedback to address", modeSummary, ...steeringItems].join("\n");

      const priorAddressingById = new Map(task.reviewState.addressing.map((record) => [record.itemId, record] as const));
      const nextAddressing = [
        ...task.reviewState.addressing.filter((record) => !selectedSet.has(record.itemId)),
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
              sourceMode: task.reviewState?.source ?? "pull-request",
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

      const reviewState = {
        ...task.reviewState,
        addressing: nextAddressing,
      };

      await scopedStore.updateTask(task.id, { reviewState });

      let steeringCommentId: string | null = null;
      const steeringComment = await scopedStore.addSteeringComment(task.id, steeringText, "user");
      steeringCommentId = steeringComment.id;

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
      if (steeringCommentId && updatedTask.column === "in-progress" && updatedTask.assignedAgentId && !hasActiveSession) {
        await triggerCommentWakeForAssignedAgent(scopedStore, updatedTask, {
          triggeringCommentType: "steering",
          triggeringCommentIds: [steeringCommentId],
          triggerDetail: "review-address",
        });
      }

      await scopedStore.logEntry(task.id, "Same-task review revision requested", `${selectedItems.length} item(s) submitted from review tab`);
      res.json({ task: updatedTask, reviewState });
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
