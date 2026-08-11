import { createIngestedCheckResolver, createLogger, isCurrentSpecDriftReport, resolveRequiredCheckNames } from "@fusion/core";
import type { Request, Response } from "express";

const severityAuditLog = createLogger("dashboard-register-task-workflow-routes");

/**
 * FNXC:CodingIdeasWorkflow 2026-07-26-15:30:
 * Per-request ceiling on `awaitingPlanning` PROMPT.md reads (one per Todo row). Boards this large
 * are pathological; beyond the cap the remaining cards keep TaskCard's step-count fallback rather
 * than turning one board load into thousands of file reads. Truncation is logged, never silent.
 */
const AWAITING_PLANNING_ENRICH_LIMIT = 200;
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  TaskStore,
  Task,
  TaskDetail,
  TaskSource,
  Column,
  TaskReviewData,
  TaskReviewItem,
  TaskReviewSummary,
  TaskReviewVerdict,
  WorkflowStepResult,
  GithubIssueAction,
  DuplicateCandidate,
  DuplicateMatch,
  RunAuditEvent,
  ArtifactType,
  PrInfo,
  WorkflowIr,
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
  evaluateImplementationTaskBind,
  applyWorkflowSettingsOverlay,
  resolveEffectiveSettingsDetailed,
  getCurrentRepo,
  findDuplicateMatches,
  deterministicGuardLocks,
  runDeterministicDuplicateGuard,
  buildAutoPauseClearPatch,
  buildManualRetryResetPatch,
  reconcileDeterministicDuplicate,
  extractIntentSignature,
  findNearDuplicates,
  isNearDuplicateCanonicalInactive,
  resolveNearDuplicateCanonicalFlags,
  isEphemeralAgent,
  parseExplicitDuplicateMarker,
  resolveExplicitDuplicateMarker,
  resolveWorkflowIrForTask,
  resolveWorkflowIrForTaskWithProvenance,
  resolveReviewColumns,
  workflowHasColumn,
  workflowPlansInColumn,
  workflowDeclaresColumnModel,
  resolveLifecycleColumns,
  columnHasFlag,
  columnsWithFlag,
  resolveReboundTarget,
  resolveColumnFlags,
  PLAN_REVIEW_GROUP_ID,
  TransitionRejectionError,
  ArchivedTaskDocumentPublicationRejectedError,
  TaskDocumentPreconditionFailedError,
  validateArchivedTaskDocumentAddition,
  validateTaskDocumentPreconditions,
  getPlannerInterventionTimeline,
  isBuiltinWorkflowId,
  resolveProjectColumnsForRoles,
  type NearDuplicateCandidate,
  type ThinkingLevel,
} from "@fusion/core";
import { GitHubClient } from "../github.js";
import { resolveArtifactMediaPath } from "../artifact-media.js";
import { archivedColumnsForTask } from "../task-lifecycle-lanes.js";
import { githubRateLimiter } from "../github-poll.js";
import { createTrackingIssueForTask } from "../github-tracking-hook.js";
import { parseGitHubBadgeUrl } from "./register-git-github.js";
import {


  planTaskWorktreePath,
  promoteHeldTask,
  evaluateTaskReleaseGate,
  performTaskRevert,
  revertWorkspaceTask,
  TaskRevertError,
  createAiUndoTask,
  prepareRevertPrBranch,
  prepareWorkspaceRevertPrBranches,
  isInReviewMissingWorktreeSessionStartFailure,
  inspectExternalGitCheckout,
  // FN-8004 follow-up: shared with SelfHealingManager.recoverStaleMergingStatus so the manual
  // Retry gate and the automatic sweep agree on when a merge-active stamp is orphaned.
  isStaleMergeActiveStatus,
  resumeApprovedPlanReviewHandoff,
  type ApprovedPlanReviewHandoffResult,
  type AiUndoTaskResult,
  type PrepareRevertPrBranchResult,
  type PrepareWorkspaceRevertPrBranchesResult,
  type WorkspaceRepoRevertPrBranch,
} from "@fusion/engine";
import { buildBoardWorkflowsPayload } from "./board-workflows.js";
import { resolveNativeStructurePreview } from "../native-structure-preview.js";
import { isBackwardMoveBlockedByOpenPr, PR_OPEN_BLOCKS_MOVE_BACK_MESSAGE } from "./register-pull-requests-routes.js";
import { computePlanApprovalFingerprint, isTaskAwaitingPlanning, isWorkspaceTask, type RunAuditEventInput } from "@fusion/core";
import { FUSION_CLIENT_HEADER, resolveHttpDeleteCallerKind } from "@fusion/core";
import { ApiError, badRequest, conflict, notFound } from "../api-error.js";
// FNXC:TaskLookup404 2026-07-26-11:40: shared task-miss -> 404 mapping seam.
import { isTaskLookupMiss, rethrowTaskApiError } from "./task-lookup-error.js";
import type { ApiRoutesContext } from "./types.js";
import { deriveAutoTaskBranch, derivePerTaskBranch, getBranchSelectionMode, resolveBranchSelection } from "./branch-selection.js";
import { isDaemonAuthActive } from "../auth-middleware.js";

/*
FNXC:WorkflowResolvedColumns 2026-07-31-13:45 (fleet — inline fallback arms):
DELIBERATE-LITERAL — the no-resolution fallbacks for the already-converted guards below.

Named sets rather than inline `=== "<id>"` arms. Behaviour is identical; the census counts an inline
comparison whether or not it sits in a fallback branch (its `traitFallback` hint is advisory and never
changes the count), so a correctly-converted guard with an inline legacy arm stays on the backlog
permanently and the number stops distinguishing real debt from documented degraded answers.
*/
const LEGACY_WIP_LANES: ReadonlySet<string> = new Set(["in-progress"]);
const LEGACY_ARCHIVE_LANES: ReadonlySet<string> = new Set(["archived"]);


const REVIEW_BLOCK_RE = /##\s+(Code|Plan)\s+Review:[\s\S]*?(?=\n##\s+(?:Code|Plan)\s+Review:|$)/gi;
const REVIEW_VERDICT_RE = /###\s+Verdict:\s*(APPROVE|REVISE|RETHINK|UNAVAILABLE)\b/i;
const REVIEW_STEP_RE = /^(plan|code) review Step (\d+): (APPROVE|REVISE|RETHINK|UNAVAILABLE)\b/i;
const DUPLICATE_STOPWORDS = new Set(["a", "an", "the", "and", "or", "of", "to", "for", "in", "is", "on", "with", "fn"]);
const ARTIFACT_TYPES = new Set<ArtifactType>(["document", "image", "video", "audio", "other"]);
const ADDRESS_PR_FEEDBACK_PROMPT = "Run /ce-resolve-pr-feedback to resolve open PR review feedback: evaluate each thread, fix valid issues, and reply.";

async function clearRebuiltSpecWorkflowPins(store: TaskStore, taskId: string): Promise<void> {
  /*
  FNXC:WorkflowReplan 2026-06-29-00:33:
  Spec rebuild intentionally invalidates the planned step source, so persisted graph foreach pins from the previous PROMPT.md must be cleared before the next parse-steps node runs. Keeping the stale pins makes rebuilt tasks fail closed with pin-mismatch at parse instead of executing the fresh plan.

  FNXC:WorkflowReset 2026-06-29-10:02:
  User reset/retry is also a hard graph-run boundary. Clear all persisted foreach step-instance rows for the task, not only rows outside a keep-run id, because stale rows can be written by an old aborting graph after the first cleanup and then make the next parse fail immediately.
  */
  const maybeStore = store as unknown as {
    clearWorkflowRunStepInstancesAsync?: (taskId: string) => Promise<void>;
    clearWorkflowRunStepInstances?: (taskId: string) => void;
  };
  try {
    await (maybeStore.clearWorkflowRunStepInstancesAsync?.(taskId)
      ?? maybeStore.clearWorkflowRunStepInstances?.(taskId));
  } catch {
    // Legacy stores may not have workflow-run instance persistence; rebuild must still proceed.
  }
}

/*
FNXC:WorkflowColumns 2026-07-19-2b:30 (U12 / R2 / R11):
IR-derived move targets for the operator lifecycle routes.

Retry / reset / re-engage all moved the card with a hardcoded `"todo"` or `"in-progress"`. On a
user-authored workflow those ids may not exist at all, so the operator's Retry button either threw
or silently parked the card in a column the workflow never declared. These resolve the destination
from the TASK'S OWN workflow by TRAIT — the rebound target is the `hold` column (falling back to
`intake`), the execution target is the column carrying `wip`.

Both fall back to the legacy literal when the IR cannot be resolved or declares no columns (v1),
so `builtin:coding` — whose hold column IS `todo` and whose wip column IS `in-progress` — keeps
byte-identical behavior (KTD-7).
*/
async function resolveReboundColumnForTask(store: TaskStore, taskId: string): Promise<string> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    return resolveReboundTarget(ir) ?? "todo";
  } catch {
    return "todo";
  }
}

/*
FNXC:WorkflowColumns 2026-07-19-2b:35 (U12 / R2):
Spec revision rehomes to the workflow's INTAKE column (where specification happens), which is a
different preference from the rebound target above — rebound prefers `hold`, respecify prefers
`intake`. `builtin:coding`'s intake column IS `triage`, so the default path is unchanged.
*/
async function resolveIntakeColumnForTask(store: TaskStore, taskId: string): Promise<string> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    return columnsWithFlag(ir, "intake")[0] ?? "triage";
  } catch {
    return "triage";
  }
}

/**
 * FNXC:PlanReviewReplan 2026-08-04-06:35 FN-8768:
 * Plan approval normally belongs in workflow intake. An exhausted Plan Review stays where the
 * review node ran, and both operator decisions must be accepted there. Keep approve/reject on one
 * resolver so the UI cannot offer a choice that only one endpoint understands.
 */
async function resolvePlanApprovalColumnsForTask(
  store: TaskStore,
  task: Task,
): Promise<{ approvalColumn: string; intakeColumn: string }> {
  try {
    const ir = await resolveWorkflowIrForTask(store, task.id);
    const intakeColumn = columnsWithFlag(ir, "intake")[0] ?? "triage";
    const approvalColumn = task.awaitingApprovalReason === "plan-review-replan-cap"
      ? ir.nodes.find((node) => node.id === PLAN_REVIEW_GROUP_ID)?.column ?? intakeColumn
      : intakeColumn;
    return { approvalColumn, intakeColumn };
  } catch {
    return { approvalColumn: "triage", intakeColumn: "triage" };
  }
}

/*
FNXC:WorkflowResolvedColumns 2026-07-27-16:15 (U10 / R8):
Lifecycle POSITION — "is this move backward?" — resolved through `COLUMNS.indexOf(...)`, the
legacy enum. A workflow that renames its lanes returns -1 for both endpoints, and
`isBackwardMoveBlockedByOpenPr` treats a negative index as "cannot tell → allow", so the open-PR
guard silently stopped existing on every custom board rather than rejecting anything. A guard that
never fires does not fail a test.

`ir.columns` is ordered and that order IS the lifecycle order (see the graph entry contract), so
the workflow is the authority. The legacy enum stays as the fallback for an unresolvable or v1
(column-less) IR, which keeps `builtin:coding` — whose column order equals the enum — unchanged.
*/
/*
FNXC:WorkflowResolvedColumns 2026-07-27-18:20 (U10 / R8 — greptile P1 on PR #2492):
The workflow is authoritative ONLY when it can place BOTH endpoints. Using its ordering
unconditionally reopened the same hole from the other side: a row still stored in a column the
workflow removed or renamed scores -1, and a negative index means "allow" — so exactly the rows
U11 leaves behind in `todo` could be dragged backward past an open PR.

Two orderings, never mixed. Mixing them would misjudge a workflow that REORDERS legacy ids (its
own order says forward while the enum says backward), so the enum is a fallback for the whole
comparison, not a per-column patch.

Residual, deliberately not papered over: when the source is undeclared AND the target is a
workflow-only id, neither ordering places both and the guard cannot fire. That is NOT a
regression — the previous `COLUMNS.indexOf` scored the custom target -1 and was equally absent.
Closing it needs the guard restated in terms of column TRAITS rather than position, which belongs
with the merge lane's conversion (U9), not with a rendering unit.
*/
function resolveMoveOrderIndices(
  ir: WorkflowIr | undefined,
  fromColumn: string,
  toColumn: string,
): { fromIndex: number; toIndex: number } {
  const declared = (ir as { columns?: Array<{ id: string }> } | undefined)?.columns;
  if (Array.isArray(declared) && declared.length > 0) {
    const order = new Map(declared.map((column, index) => [column.id, index]));
    const fromIndex = order.get(fromColumn) ?? -1;
    const toIndex = order.get(toColumn) ?? -1;
    if (fromIndex >= 0 && toIndex >= 0) return { fromIndex, toIndex };
  }
  return {
    fromIndex: COLUMNS.indexOf(fromColumn as Column),
    toIndex: COLUMNS.indexOf(toColumn as Column),
  };
}

async function resolveWipColumnForTask(store: TaskStore, taskId: string): Promise<string> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    return columnsWithFlag(ir, "countsTowardWip")[0] ?? "in-progress";
  } catch {
    return "in-progress";
  }
}

/*
FNXC:WorkflowResolvedColumns 2026-07-31-03:30 (fleet: register-task-workflow-routes.ts):
The three roles this file needed and did not have, following the idiom its own
`resolveIntakeColumnForTask` / `resolveWipColumnForTask` / `resolveReboundColumnForTask` already
established: resolve the column ID from the task's workflow, fall back to the legacy id when the IR
cannot be read.

Deliberately NOT the `columnRoles` predicate helpers used in `packages/dashboard/app`. Those take
resolved trait flags, which a route handler does not have — it has a store and a task id, and must
do an async lookup. Importing them here would mean fetching flags per request to answer a question
this file already answers a simpler way. One idiom per layer.

`resolveReviewColumnForTask` accepts EITHER trait, matching `isReviewColumnRole` on the app side: a
lane can block merges without a human in it and vice versa, and every caller here asks "is this card
in review".
*/
/*
FNXC:WorkflowResolvedColumns 2026-07-31-06:40 (PR #2713 review — greptile P1, same class as the
terminal finding one round earlier):
MEMBERSHIP, because `mergeBlocker` and `humanReview` can sit on DIFFERENT columns.

The previous shape took `columnsWithFlag(ir, "mergeBlocker")[0] ?? columnsWithFlag(ir,
"humanReview")[0]` — one id. A workflow that splits the two (a merge lane and a separate sign-off
lane) then classified a task in the second as outside review entirely, so comment re-engagement was
suppressed on a card sitting in human review.

I fixed exactly this arity bug for the terminal columns one review round earlier and did not
generalise it. The rule, stated so the next resolver added here does not repeat it a third time:
single id answers "where should this card GO" — a move target must be one column. A SET answers "is
this card ALREADY there" — membership. Every resolver used in a comparison against `task.column` is
the second kind.
*/
async function resolveReviewColumnsForTask(store: TaskStore, taskId: string): Promise<Set<string>> {
  /*
  FNXC:WorkflowLifecycleColumns 2026-08-02-22:20 (consolidation onto #2730's core resolver):
  THE BODY IS NOW CORE'S. This resolver went through three shapes in three review rounds — a single id, then a
  membership set over mergeBlocker/humanReview (#2713), then plus the FIRST mergeOrchestration column (#2723) —
  and every round was an argument about arity at one call site. #2730 settled it in core, authoritatively and
  for every surface, so the local body is deleted and only the store lookup and the legacy fallback remain.

  The WRAPPER stays: this file's callers hold a store and a task id, not an IR, which is the same reason its
  sibling resolvers exist. One idiom per layer; one definition per question.
  */
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    const lanes = resolveReviewColumns(ir);
    return lanes.length > 0 ? new Set(lanes) : new Set(["in-review"]);
  } catch {
    return new Set(["in-review"]);
  }
}

/*
FNXC:WorkflowResolvedColumns 2026-07-31-05:00 (PR #2713 review — greptile P1):
MEMBERSHIP, not "the first one". A workflow may declare MORE THAN ONE column carrying `complete` or
`archived`, and `columnsWithFlag(...)[0]` picks one of them — so a task sitting in the second valid
terminal column failed the revert guard with a 409.

The single-id shape is right for the file's older resolvers, which answer "where should this card
GO" (a move target must be one column). It is wrong here, because these answer "is this card ALREADY
terminal" — a membership question. Same helper name, opposite arity requirement; that is what made
the flaw easy to inherit.

Returns the full set and lets callers test membership. The legacy id is the fallback set when the IR
cannot be read, matching the other resolvers' degraded behaviour.
*/
async function resolveTerminalColumnsForTask(store: TaskStore, taskId: string): Promise<Set<string>> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    const complete = columnsWithFlag(ir, "complete");
    const archived = columnsWithFlag(ir, "archived");
    const all = [...complete, ...archived];
    return all.length > 0 ? new Set(all) : new Set(["done", "archived"]);
  } catch {
    return new Set(["done", "archived"]);
  }
}

function isArtifactType(value: string): value is ArtifactType {
  return ARTIFACT_TYPES.has(value as ArtifactType);
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
    severityAuditLog.warn(`[merge-advance-events] dropping run-audit event ${event.id}: missing metadata`);
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
    severityAuditLog.warn(`[merge-advance-events] dropping run-audit event ${event.id}: missing integrationBranch or toSha`);
    return null;
  }
  if (typeof event.taskId !== "string" || event.taskId.length === 0) {
    severityAuditLog.warn(`[merge-advance-events] dropping run-audit event ${event.id}: missing taskId`);
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

/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — PR #2582 review, greptile):
COLUMN REMOVED from the shared constant. It hardcoded `todo`, so drift correction forced
the card there regardless of the workflow's actual rebound column — and then the final
verification (which now compares against `resetColumn`) saw the mismatch and raised the
very 409 "limbo" conflict this change exists to remove. Fixing the check without fixing
the writer just moved the bug.

The column is supplied per call from the resolved rebound column; everything else here is
genuinely column-independent cleanup.
*/
const RESET_DRIFT_CORRECTION_FIELDS = {
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

function scheduleReleaseExecutionAgentBindings(
  engine: Parameters<typeof releaseExecutionAgentBindings>[0],
  taskId: string,
  runtimeLogger: { warn: (message: string, data?: Record<string, unknown>) => void },
): void {
  /*
  FNXC:TaskDeletion 2026-07-15-09:52:
  The DELETE /tasks/:id response must not wait for an includeEphemeral agent-store scan or per-agent unlink/delete calls after the DB soft-delete has committed. Keep releaseExecutionAgentBindings as the reliable cleanup implementation, but run it off the HTTP critical path and log failures so agent-binding cleanup remains observable instead of silently dropped.
  */
  void releaseExecutionAgentBindings(engine, taskId).catch((error: unknown) => {
    runtimeLogger.warn("Deferred task-delete agent binding release failed", {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
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
  classifyBlocker: (canonical: Pick<Task, "id" | "column" | "deletedAt">) => Promise<boolean>,
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
  const eligibility = await Promise.all(results.map(async (task) => ({
    task,
    blocker: await classifyBlocker(task),
  })));
  const eligibleResults = eligibility.filter(({ blocker }) => blocker).map(({ task }) => task);
  const candidates: DuplicateCandidate[] = eligibleResults.map((task) => ({
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

async function isDuplicateBlocker(
  store: TaskStore,
  canonical: Pick<Task, "id" | "column" | "deletedAt">,
): Promise<boolean> {
  const flags = await resolveNearDuplicateCanonicalFlags(store, canonical);
  return !isNearDuplicateCanonicalInactive(canonical, flags);
}

function buildReviewerAgentItemId(input: { index: number; reviewType: "plan" | "code"; step?: number; verdict?: string; createdAt?: string }): string {
  const stepPart = input.step ? `step-${input.step}` : "step-na";
  const verdictPart = (input.verdict ?? "unknown").toLowerCase();
  const timePart = (input.createdAt ?? "na").replace(/[:.]/g, "-");
  return `reviewer-${input.reviewType}-${stepPart}-${verdictPart}-${timePart}-${input.index + 1}`;
}

const CURRENT_WORKFLOW_REVIEW_STEP_IDS = new Set(["code-review", "plan-review"]);
const CURRENT_WORKFLOW_REVIEW_STATUSES = new Set<WorkflowStepResult["status"]>(["passed", "failed"]);
const LEGACY_WORKFLOW_REVIEW_STATUSES = new Set<WorkflowStepResult["status"]>(["passed", "failed", "advisory_failure"]);
function parseTaskReviewVerdict(value: string | undefined): TaskReviewVerdict | undefined {
  switch (value) {
    case "APPROVE":
    case "APPROVE_WITH_NOTES":
    case "REVISE":
    case "RETHINK":
    case "UNAVAILABLE":
      return value;
    default:
      return undefined;
  }
}

/**
 * FNXC:TaskReview 2026-08-05-01:57:
 * The current graph-owned Code Review and Plan Review ids are the only structured review sources:
 * current, terminal, verdict-bearing results win over compatibility-only reviewer prose/activity
 * parsing. Their persisted identity produces canonical ids so GET, refresh, and address reconstruct
 * the same server-owned feedback; address snapshots and steering must never trust client prose.
 * Explicit `reviewKind` results may also qualify when terminal and nonblank; custom names,
 * verdicts, and gate modes remain non-semantic. Historical attempts, pending/skipped,
 * superseded, and bypassed results are non-selectable.
 */
function hasCurrentWorkflowReviewIdentity(result: WorkflowStepResult): boolean {
  return result.supersededAt === undefined
    && result.supersededReason === undefined
    && result.bypassedBy === undefined
    && result.bypassedAt === undefined
    && result.bypassReason === undefined
    && result.bypassedFromStatus === undefined
    && result.bypassedFromVerdict === undefined;
}

function isCurrentMarkedWorkflowReviewResult(result: WorkflowStepResult): result is WorkflowStepResult & { reviewKind: "plan" | "code" } {
  return CURRENT_WORKFLOW_REVIEW_STATUSES.has(result.status)
    && hasCurrentWorkflowReviewIdentity(result)
    && Boolean(result.output?.trim() || result.notes?.trim())
    && (result.reviewKind === "plan" || result.reviewKind === "code")
    && (result.source === "node" || result.source === "optional-group");
}

async function getDeclaredTopLevelReviewResultSources(task: Task, store: TaskStore): Promise<Map<string, WorkflowStepResult["source"]>> {
  const resolved = await resolveWorkflowIrForTaskWithProvenance(store, task.id);
  if (resolved.source !== "selection") return new Map();

  /*
  FNXC:WorkflowReviewKind 2026-08-05-06:14:
  A persisted marker is authoritative only for a node and result source that the task's selected
  workflow declares at the top level. Resolve exact node identities instead of reserving punctuation: custom node IDs
  may legitimately contain `::` or `#<number>:`, while template instances have no matching top-level
  declaration and remain outside this task's currentness/addressing contract.
  */
  return new Map(resolved.ir.nodes.flatMap((node): Array<[string, WorkflowStepResult["source"]]> => {
    if (node.kind === "optional-group") return [[node.id, "optional-group"]];
    if (node.kind === "prompt" || node.kind === "gate" || node.kind === "script") return [[node.id, "node"]];
    return [];
  }));
}

function isCurrentLegacyWorkflowReviewResult(result: WorkflowStepResult): boolean {
  // Historical built-ins predate reviewKind. Preserve FN-8793's deliberately narrow
  // id-and-verdict compatibility contract without applying marked-custom requirements.
  return CURRENT_WORKFLOW_REVIEW_STEP_IDS.has(result.workflowStepId)
    && result.reviewKind === undefined
    && LEGACY_WORKFLOW_REVIEW_STATUSES.has(result.status)
    && result.verdict !== undefined
    && hasCurrentWorkflowReviewIdentity(result);
}

function getWorkflowReviewKind(
  result: WorkflowStepResult,
  declaredTopLevelReviewResultSources: ReadonlyMap<string, WorkflowStepResult["source"]>,
): "plan" | "code" | undefined {
  if (isCurrentMarkedWorkflowReviewResult(result) && declaredTopLevelReviewResultSources.get(result.workflowStepId) === result.source) return result.reviewKind;
  if (isCurrentLegacyWorkflowReviewResult(result)) {
    return result.workflowStepId === "plan-review" ? "plan" : "code";
  }
  return undefined;
}

function buildWorkflowReviewItemId(task: Task, result: WorkflowStepResult, findingId?: string, resolution?: string): string {
  const identity = JSON.stringify({
    taskId: task.id,
    workflowStepId: result.workflowStepId,
    workflowStepName: result.workflowStepName,
    phase: result.phase,
    status: result.status,
    verdict: result.verdict,
    reviewKind: result.reviewKind,
    completedAt: result.completedAt,
    startedAt: result.startedAt,
    output: result.output,
    notes: result.notes,
    findingId,
    resolution,
  });
  return `workflow-review-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

async function buildWorkflowReviewItems(task: Task, store: TaskStore): Promise<TaskReviewItem[]> {
  const declaredTopLevelReviewResultSources = await getDeclaredTopLevelReviewResultSources(task, store);
  return (task.workflowStepResults ?? [])
    .flatMap((result): TaskReviewItem[] => {
      const reviewType = getWorkflowReviewKind(result, declaredTopLevelReviewResultSources);
      if (!reviewType) return [];
      const timestamp = result.completedAt ?? result.startedAt ?? task.updatedAt ?? task.createdAt;
      if (result.findings?.length) {
        return result.findings.map((finding) => ({
          itemId: buildWorkflowReviewItemId(task, result, finding.id, finding.resolution),
          sourceMode: "reviewer-agent" as const,
          title: finding.title,
          body: finding.body,
          author: "reviewer-agent",
          createdAt: timestamp,
          updatedAt: timestamp,
          ...(finding.filePath ? { filePath: finding.filePath } : {}),
          ...(finding.line ? { line: finding.line } : {}),
          ...(finding.severity ? { severity: finding.severity } : {}),
          ...(finding.resolution ? { resolution: finding.resolution } : {}),
          reviewState: result.verdict,
          verdict: result.verdict,
          reviewType,
          progressStatus: null,
        }));
      }
      const body = result.output?.trim() || result.notes?.trim() || "No written feedback was provided by this review step.";
      return [{
        itemId: buildWorkflowReviewItemId(task, result),
        sourceMode: "reviewer-agent",
        title: `${result.workflowStepName || result.workflowStepId} ${result.verdict ?? result.status}`,
        body,
        author: "reviewer-agent",
        createdAt: timestamp,
        updatedAt: timestamp,
        reviewState: result.verdict,
        verdict: result.verdict,
        reviewType,
        progressStatus: null,
      }];
    })
    .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? "") || a.itemId.localeCompare(b.itemId));
}

function buildDirectReviewSummary(items: TaskReviewItem[]): TaskReviewSummary | null {
  const latest = items[0];
  return latest
    ? { summary: latest.title, verdict: latest.verdict }
    : null;
}

async function buildDirectTaskReviewData(task: Task, store: TaskStore): Promise<TaskReviewData> {
  const structuredItems = await buildWorkflowReviewItems(task, store);
  if (structuredItems.length > 0) {
    return {
      mode: "reviewer-agent",
      refreshable: true,
      fetchedAt: new Date().toISOString(),
      summary: buildDirectReviewSummary(structuredItems),
      items: structuredItems,
    };
  }

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
      verdict: parseTaskReviewVerdict(verdict),
      reviewType,
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
        verdict: parseTaskReviewVerdict(verdict),
        reviewType,
        progressStatus: null,
      });
    });
  }

  const sorted = [...items].sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? "") || a.itemId.localeCompare(b.itemId));

  return {
    mode: "reviewer-agent",
    refreshable: true,
    fetchedAt: new Date().toISOString(),
    summary: buildDirectReviewSummary(sorted),
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
    getStaleMergingStatusMinAgeMs: () => number;
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
    const reviewGateColumns = await resolveReviewColumnsForTask(scopedStore, task.id);
    if (!reviewGateColumns.has(task.column)) {
      return { task, reengaged: false, suppressedReason: "not-in-review" };
    }
    if (task.sessionFile) {
      return { task, reengaged: false, suppressedReason: "live-session" };
    }

    const activePrEntity =
      (await scopedStore.getActivePrEntityBySource?.("task", task.id)) ??
      (task.branchContext?.groupId
        ? await scopedStore.getActivePrEntityBySource?.("branch-group", task.branchContext.groupId)
        : null);
    /*
    FNXC:WorkflowResolvedColumns 2026-07-27-16:20 (U10 / R8):
    Deliberately still on the legacy enum, unlike the move route's copy of this guard. This whole
    function is gated on the literal `task.column !== "in-review"` above and re-engages to the
    literal `"in-progress"`, so both endpoints are legacy ids by construction and the enum resolves
    them correctly. Swapping in the task's workflow order here would make the guard WEAKER, not
    stronger: a workflow declaring `in-review` but not `in-progress` would score -1 for the target
    and disable the guard entirely. Convert this site when its surrounding literals are converted
    (U5 owns the re-engage lane), not before.
    */
    if (
      isBackwardMoveBlockedByOpenPr({
        /*
        FNXC:WorkflowResolvedColumns 2026-07-31-05:20 (PR #2713 review — greptile P1):
        The REVIEW LANE'S legacy index, not `COLUMNS.indexOf(task.column)`.

        `isBackwardMoveBlockedByOpenPr` bails with `if (fromIndex < 0) return false`, and
        `COLUMNS.indexOf` returns -1 for any custom column id. Before this PR the gate above only
        admitted a task literally in `in-review`, so the index was always valid; converting the gate
        to resolve the review ROLE started admitting custom columns, and the guard then silently
        stopped protecting them — the task moved out of review with an open PR.

        A conversion that widens what reaches a downstream legacy-index check has to carry that
        check with it. We have already established `task.column` IS this workflow's review lane, so
        it occupies the review POSITION for an ordering question, whatever it is named.
        */
        fromIndex: COLUMNS.indexOf("in-review"),
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

    const reengageColumn = await resolveWipColumnForTask(scopedStore, task.id);
    const reengagedTask = await scopedStore.moveTask(task.id, reengageColumn, { preserveProgress: true });
    await triggerCommentWakeForAssignedAgent(scopedStore, reengagedTask, wake);
    return { task: reengagedTask, reengaged: true };
  }

  // Get recent integration-branch advance events for post-merge notice
  router.get("/tasks/merge-advance-events", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const limit = parseMergeAdvanceLimit(req.query.limit);
      const storeWithRunAudit = scopedStore as TaskStore & {
        getRunAuditEventsAsync: (filters: {
          taskId?: string;
          domain?: "database" | "git" | "filesystem" | "sandbox";
          mutationType?: string;
          limit?: number;
        }) => Promise<RunAuditEvent[]>;
      };

      const advanceEvents = await storeWithRunAudit.getRunAuditEventsAsync({
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
        const stateEvents = await storeWithRunAudit.getRunAuditEventsAsync({
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
        const autoSyncEvents = await storeWithRunAudit.getRunAuditEventsAsync({
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
      // FNXC:TaskStoreForensicRead 2026-06-26-15:30:
      // VAL-CROSS-003 / VAL-DATA-006 — Forensic read surface. When
      // includeDeleted=true is passed, soft-deleted tasks (deletedAt IS NOT
      // NULL) are surfaced for admin/forensic consumers. Default (unset/false)
      // preserves the live-reader invariant (VAL-DATA-005): tombstoned tasks
      // never appear on the board. Only honored on the list path (no `q`),
      // since search has its own deletedAt filter that is intentionally live-only.
      const includeDeleted = req.query.includeDeleted === "1" || req.query.includeDeleted === "true";
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
        // includeDeleted propagates to the store forensic read path (VAL-DATA-006).
        const listOptions = { limit, offset, slim: true, includeArchived, ...(includeDeleted ? { includeDeleted } : {}), ...(column ? { column } : {}) };
        tasks = await scopedStore.listTasks(listOptions);
      }

      // Residual B (U9/U13): additively populate `branchProgress` when the
      // workflowColumns flag is ON and the fan-out branch table has rows for
      // any of these tasks. One batched query (cheap; short-circuits when the
      // table is empty). The payload is otherwise byte-identical.
      try {
        // FNXC:WorkflowColumns 2026-07-27-09:52 (U2 / R9): the
        // `isWorkflowColumnsEnabled` conjunct is deleted (literal `true`), so
        // branch-progress enrichment is gated only on there being tasks.
        if (tasks.length > 0) {
          const byTask = await scopedStore.getBranchProgressByTask(tasks.map((t) => t.id));
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

      /*
      FNXC:CodingIdeasWorkflow 2026-07-26-15:30:
      Attach `awaitingPlanning` for plan-in-place (Todo) cards so the "Queued to plan" / "Ready"
      badge pair names the cap the card is actually waiting on. Same additive, best-effort,
      never-fail-the-board contract as the two enrichments above; the field is omitted (rather than
      `false`) for every other row, so those payloads stay byte-identical.

      Requirement: the badges must agree with the engine. TaskCard could only infer "unplanned" from
      `steps.length === 0`, while triage's todo-discovery and the scheduler's dispatch filter both
      decide from PROMPT.md seed-ness — so a card with a real spec but no parsed steps was labelled
      "Queued to plan" while the scheduler was already treating it as a WIP-slot candidate, and a
      re-seeded card still carrying old steps was labelled "Ready" while triage was about to plan it.
      `isTaskAwaitingPlanning` is the shared predicate, so there is one answer per card.

      Cost: one small file read per Todo row, only on this route (SSE payloads are not enriched —
      TaskCard falls back to its step-count heuristic when the field is absent). Bounded by
      AWAITING_PLANNING_ENRICH_LIMIT and logged when it truncates, so a huge Todo column degrades to
      the heuristic instead of turning a board load into thousands of reads.
      */
      try {
        /*
        FNXC:WorkflowResolvedColumns 2026-07-30-23:10 (converting R8's stated deferral):
        The hold lanes, resolved ONCE PER BOARD LOAD rather than once per card.

        The note this replaces deferred the conversion for a good reason and named the shape the
        fix had to take: "the hold column resolved per WORKFLOW from data the board payload already
        carries, not per task from the store". A per-task resolve is what made the first attempt a
        load-time regression — it read a workflow for every row BEFORE the enrich limit applied, on
        the very path whose comment above exists because unbounded reads here "turn a board load
        into thousands of reads".

        `resolveProjectColumnsForRoles` is the project-scoped shape: ONE `listWorkflowDefinitions()`
        read, independent of task count, returning every column any workflow calls `hold` unioned
        with the legacy `todo`. Measured cost is therefore one extra query per board load — flat,
        not per-row — and the enrich limit still bounds the PROMPT.md reads, which are the expensive
        part and are unchanged.

        Over-inclusion is the safe direction here, deliberately: a card sitting in some other
        workflow's hold lane is annotated with `awaitingPlanning`, which is what a waiting card in a
        waiting lane should show. Under-inclusion is what the literal did — no enrichment at all, no
        error, and a silent fall back to the client's step-count heuristic that this enrichment
        exists to correct.
        */
        const holdColumns = await resolveProjectColumnsForRoles(scopedStore, ["hold"]);
        const holdRows = tasks.filter((task) => holdColumns.has(task.column));
        const enrichable = holdRows.slice(0, AWAITING_PLANNING_ENRICH_LIMIT);
        if (holdRows.length > enrichable.length) {
          severityAuditLog.warn(
            `awaitingPlanning/releaseGate enrichment truncated: ${enrichable.length}/${holdRows.length} hold-lane tasks ` +
            "annotated (remaining cards fall back to the client step-count heuristic)",
          );
        }
        if (enrichable.length > 0) {
          const flagByTask = new Map<string, boolean>();
          const releaseGateByTask = new Map<string, import("@fusion/core").TaskReleaseGateVerdict>();
          const irCache = new Map<string, WorkflowIr>();
          await Promise.all(enrichable.map(async (task) => {
            let promptContent: string | null = null;
            try {
              promptContent = await readFile(join(scopedStore.getTaskDir(task.id), "PROMPT.md"), "utf-8");
            } catch (err: unknown) {
              // A MISSING spec means unplanned (triage regenerates it), which the predicate encodes
              // as `null`. Any other read fault is not evidence either way, so omit the field and
              // let the client fall back rather than assert a wrong label.
              if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return;
            }
            flagByTask.set(task.id, isTaskAwaitingPlanning(task, promptContent));
            /*
            FNXC:PromoteVisibility 2026-08-11-20:38:
            Share the hold-lane cap with awaitingPlanning and cache IR resolution per selected workflow:
            exact Promote visibility must not turn a board load into unbounded workflow reads.
            */
            const ir = await resolveWorkflowIrForTask(scopedStore, task.id, irCache);
            const releaseGate = await evaluateTaskReleaseGate(scopedStore, task, { ir });
            if (releaseGate) releaseGateByTask.set(task.id, releaseGate);
          }));
          if (flagByTask.size > 0 || releaseGateByTask.size > 0) {
            tasks = tasks.map((task) => {
              const awaitingPlanning = flagByTask.get(task.id);
              const releaseGate = releaseGateByTask.get(task.id);
              return awaitingPlanning === undefined && releaseGate === undefined
                ? task
                : { ...task, ...(awaitingPlanning === undefined ? {} : { awaitingPlanning }), ...(releaseGate === undefined ? {} : { releaseGate }) };
            });
          }
        }
      } catch {
        // Awaiting-planning enrichment is best-effort and must never fail the
        // board load — fall through with the un-enriched task list.
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
      // FNXC:WorkflowColumns 2026-07-27-09:53 (U2 / R9): the flag-OFF
      // `{ flagEnabled: false }` short-circuit is deleted — unreachable behind a
      // literal `true`. `buildBoardWorkflowsPayload` still emits `flagEnabled: true`
      // for shipped clients that branch on it.
      const settings = await scopedStore.getSettingsFast();
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

  /**
   * FNXC:ArchivePagination 2026-07-08-00:00:
   * Dedicated paged read for the Archived board column: newest-first
   * (`archivedAt DESC`) in chunks of 100 by default via SQL LIMIT/OFFSET,
   * so a large archive is never loaded into memory in one pass. This is a
   * sibling to GET /tasks (which stays byte-identical for its existing
   * merged-listing consumers) rather than a replacement for it.
   */
  router.get("/tasks/archived", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
      const offset = typeof req.query.offset === "string" ? Number.parseInt(req.query.offset, 10) : undefined;

      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        throw badRequest("limit must be a positive integer");
      }
      if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
        throw badRequest("offset must be a non-negative integer");
      }

      const { tasks, total, hasMore } = await scopedStore.listArchivedTasks({ limit, offset, slim: true });

      res.json({ tasks, total, hasMore });
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
      }, (canonical) => isDuplicateBlocker(scopedStore, canonical));

      res.json({ matches });
      return;
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /*
  FNXC:TaskRecommendations 2026-08-08-05:10:
  Recommendation children use this exact production intake pipeline, not a direct store write.
  Keeping normalization, duplicate guards, lock cleanup, source metadata, and workflow routing here
  prevents a convenience action from becoming a policy bypass.
  */
  const createTaskThroughGuardedIntake = async (
    req: Request,
    res: Response,
    trusted?: {
      proposalClaimId?: string;
      /** A recommendation child auto-archived by a late deterministic conflict. */
      recoverArchivedProposalTask?: Task;
      onCreated?: (task: Task) => Promise<unknown>;
      responseForCreated?: (task: Task, result: unknown) => unknown;
    },
  ): Promise<void> => {
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
        agentId,
        assignedAgentId,
        modelPresetId,
        modelProvider,
        modelId,
        validatorModelProvider,
        validatorModelId,
        planningModelProvider,
        planningModelId,
        mergerModelProvider,
        mergerModelId,
        thinkingLevel,
        validatorThinkingLevel,
        planningThinkingLevel,
        mergerThinkingLevel,
        reviewLevel,
        executionMode,
        autoMerge,
        autoMergeProvenance,
        priority,
        source,
        branch,
        baseBranch,
        branchSelection,
        nodeId,
        githubTracking,
        sessionAdvisorEnabled,
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
      const validatedMergerModelProvider = validateOptionalModelField(mergerModelProvider, "mergerModelProvider");
      const validatedMergerModelId = validateOptionalModelField(mergerModelId, "mergerModelId");

      // Validate thinkingLevel if provided
      const validThinkingLevels = [...THINKING_LEVELS];
      for (const [name, value] of Object.entries({ thinkingLevel, validatorThinkingLevel, planningThinkingLevel, mergerThinkingLevel })) {
        if (value !== undefined && value !== null && !validThinkingLevels.includes(value as ThinkingLevel)) {
          throw badRequest(`${name} must be one of: ${validThinkingLevels.join(", ")}`);
        }
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
      // FNXC:SharedBranchMemberHold 2026-08-05-22:50: only trusted TaskStore
      // writers may mark mission policy; HTTP callers express operator intent
      // solely through the autoMerge value.
      if (autoMergeProvenance !== undefined) {
        throw badRequest("autoMergeProvenance is server-managed");
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
      const mergerModel = normalizeModelSelectionPair(validatedMergerModelProvider, validatedMergerModelId);

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

      // The public aliases normalize once; owner eligibility is enforced by the shared store boundary.
      const requestedOwnerId = assignedAgentId ?? agentId;
      if (requestedOwnerId !== undefined && (typeof requestedOwnerId !== "string" || requestedOwnerId.trim() === "")) {
        throw badRequest("agentId must be a non-empty string");
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
      const duplicateBlockerVerdicts = new Map<string, Promise<boolean>>();
      const classifyDuplicateBlocker = (canonical: Pick<Task, "id" | "column" | "deletedAt">): Promise<boolean> => {
        const key = `${canonical.id}:${canonical.column}:${canonical.deletedAt ?? ""}`;
        const existing = duplicateBlockerVerdicts.get(key);
        if (existing) return existing;
        const verdict = isDuplicateBlocker(scopedStore, canonical);
        duplicateBlockerVerdicts.set(key, verdict);
        return verdict;
      };

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
        if (
          deterministicGuard.action === "duplicate"
          && deterministicGuard.existing
          && deterministicGuard.existing.proposalClaimId === trusted?.proposalClaimId
        ) {
          /*
          FNXC:TaskRecommendations 2026-08-08-05:27:
          The database proposal claim is project-scoped, cross-process at-most-once authority.
          A second process can observe its newly-created child while checking the normal content
          guard; reuse that immutable same-recommendation winner and repair the parent link rather
          than surfacing the ordinary duplicate conflict reserved for distinct recommendations.
          */
          const trustedCreateResult = await trusted?.onCreated?.(deterministicGuard.existing);
          res.status(200).json(trusted?.responseForCreated?.(deterministicGuard.existing, trustedCreateResult) ?? deterministicGuard.existing);
          return;
        }
        if (
          deterministicGuard.action === "duplicate"
          && deterministicGuard.existing
          && await classifyDuplicateBlocker(deterministicGuard.existing)
        ) {
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
            }, classifyDuplicateBlocker);
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
            const classifiedRows = await Promise.all(candidateRows.map(async (row) => {
              const full = byId.get(row.id);
              return { row, full, blocker: full ? await classifyDuplicateBlocker(full) : true };
            }));
            for (const { row, full, blocker } of classifiedRows) {
              if (acknowledgedDuplicateIds.includes(row.id)) {
                continue;
              }
              if (!blocker) {
                continue;
              }
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
        /*
        FNXC:TaskRecommendations 2026-08-08-07:57:
        Recommendation titles and descriptions are both required, so parsing only their combined
        text makes a description-only `DUPLICATE: FN-####` marker unreachable from the server-owned
        recommendation payload. Check the canonical description shape first while retaining the
        ordinary combined-input check, so both intake paths enforce the explicit-marker guard.
        */
        const explicitDuplicateMarker = parseExplicitDuplicateMarker(normalizedDescription)
          ?? parseExplicitDuplicateMarker(combinedText);
        const explicitMarkerBypassed =
          bypassDuplicateCheck === true ||
          (explicitDuplicateMarker ? acknowledgedDuplicateIds.includes(explicitDuplicateMarker.canonicalId) : false);
        if (explicitDuplicateMarker && !explicitMarkerBypassed) {
          const canonical = await scopedStore.getTask(explicitDuplicateMarker.canonicalId).catch(() => null);
          if (
            canonical
            && !canonical.deletedAt
            && await classifyDuplicateBlocker(canonical)
          ) {
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
        ...(typeof requestedOwnerId === "string" ? { assignedAgentId: requestedOwnerId.trim() } : {}),
        modelPresetId: validateOptionalModelField(modelPresetId, "modelPresetId"),
        modelProvider: executorModel.provider ?? undefined,
        modelId: executorModel.modelId ?? undefined,
        validatorModelProvider: validatorModel.provider ?? undefined,
        validatorModelId: validatorModel.modelId ?? undefined,
        planningModelProvider: planningModel.provider ?? undefined,
        planningModelId: planningModel.modelId ?? undefined,
        mergerModelProvider: mergerModel.provider ?? undefined,
        mergerModelId: mergerModel.modelId ?? undefined,
        thinkingLevel: thinkingLevel || undefined,
        validatorThinkingLevel: validatorThinkingLevel || undefined,
        planningThinkingLevel: planningThinkingLevel || undefined,
        mergerThinkingLevel: mergerThinkingLevel || undefined,
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
        // FNXC:PlannerOversight 2026-07-14-18:11: only persist when client sent an explicit boolean override.
        ...(typeof sessionAdvisorEnabled === "boolean" ? { sessionAdvisorEnabled } : {}),
        ...(trusted?.proposalClaimId ? { proposalClaimId: trusted.proposalClaimId } : {}),
      };

      /*
      FNXC:TaskRecommendations 2026-08-08-08:34:
      A late deterministic conflict archives the just-created recommendation child but retains its
      immutable proposal claim. Re-run every normal intake guard before restoring that child: an
      unchanged canonical still produces the standard duplicate conflict, while an inactive
      canonical lets the original claimed child return to its workflow-resolved intake lane.
      */
      if (trusted?.recoverArchivedProposalTask) {
        /*
        FNXC:TaskRecommendations 2026-08-08-08:44:
        A deterministic-duplicate archive is a lane move, not an operator archive, so it has no
        pre-archive history for generic restore to replay. Re-home its recovered child to that
        child's workflow intake explicitly; otherwise custom workflows can restore it to a legacy
        fallback or complete lane instead of the normal guarded-intake destination.

        FNXC:TaskRecommendations 2026-08-09-06:06:
        Never call the cold-storage unarchive path here. Deterministic reconciliation keeps the row in
        active storage and may move it to a custom archived-trait lane; re-home that live row directly
        through the explicit recovery bypass because archive-to-intake is intentionally non-adjacent.
        */
        const archivedTask = trusted.recoverArchivedProposalTask;
        const intakeColumn = await resolveIntakeColumnForTask(scopedStore, archivedTask.id);
        const recoveredTask = archivedTask.column === intakeColumn
          ? archivedTask
          : await scopedStore.moveTask(archivedTask.id, intakeColumn, { recoveryRehome: true });
        const trustedCreateResult = await trusted.onCreated?.(recoveredTask);
        res.status(200).json(trusted.responseForCreated?.(recoveredTask, trustedCreateResult) ?? recoveredTask);
        return;
      }

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
            const group = (await scopedStore.getBranchGroupByBranchName(sharedFeatureBranch))
              ?? await scopedStore.ensureBranchGroupForSource("new-task", sharedFeatureBranch, { branchName: sharedFeatureBranch });
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
        onDuplicate: async (canonical) =>
          await classifyDuplicateBlocker(canonical)
            ? "archive-created"
            : "keep-created",
      });
        if (deterministicReconcile.outcome === "archived") {
          /*
          FNXC:TaskRecommendations 2026-08-08-08:26:
          A recommendation child that loses the post-create deterministic race cannot be presented
          as a successful Created action. Its parent remains unlinked, so return the same
          duplicate_candidates conflict shape as the pre-create guard rather than an unwrapped task.
          */
          if (trusted?.proposalClaimId) {
            throw conflict("duplicate_candidates", {
              matches: [{
                id: deterministicReconcile.canonical.id,
                title: deterministicReconcile.canonical.title ?? "",
                description: deterministicReconcile.canonical.description ?? "",
                column: deterministicReconcile.canonical.column,
                score: 1,
                deterministic: true,
              }],
            });
          }
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

        const trustedCreateResult = await trusted?.onCreated?.(taskWithBranchContext);
        res.status(201).json(trusted?.responseForCreated?.(taskWithBranchContext, trustedCreateResult) ?? taskWithBranchContext);
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
        || /is a fragment and cannot be selected/.test(message)
        || message.startsWith("Task intake owner resolution failed:");
      const status = isClientError ? 400 : 500;
      throw new ApiError(status, message);
    }
  };

  // Ordinary dashboard creation deliberately shares the guarded production intake above.
  router.post("/tasks", async (req, res) => {
    await createTaskThroughGuardedIntake(req, res);
  });

  /*
  FNXC:TaskRecommendations 2026-08-08-05:27:
  A recommendation key must serialize BEFORE the guarded intake takes its content-fingerprint lock.
  Otherwise two clicks can both pass pre-create duplicate checks and the loser observes a duplicate
  conflict instead of the one child it is required to reuse. The key includes project identity,
  because task ids are composite project-scoped identities.
  */
  const acquireRecommendationIdempotencyLock = async (projectId: string, taskId: string, recommendationId: string): Promise<() => void> => {
    const key = `recommendation-idempotency:${projectId}:${taskId}:${recommendationId}`;
    const predecessor = deterministicGuardLocks.get(key);
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    deterministicGuardLocks.set(key, gate);
    if (predecessor) await predecessor;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate?.();
      if (deterministicGuardLocks.get(key) === gate) deterministicGuardLocks.delete(key);
    };
  };

  router.post("/tasks/:id/recommendations/:recommendationId/create", async (req, res) => {
    let releaseParentRecommendationLock: (() => void) | undefined;
    let releaseRecommendationLock: (() => void) | undefined;
    try {
      if (req.body && Object.keys(req.body).length > 0) {
        throw badRequest("recommendation creation does not accept client-controlled task options");
      }
      const { store: scopedStore, projectId } = await getProjectContext(req);
      const lockProjectId = projectId ?? "default";
      /*
      FNXC:TaskRecommendations 2026-08-08-06:42:
      Recommendation links share one JSONB parent field. Serialize all recommendation mutations
      for that parent before taking an individual recommendation key so simultaneous actions for
      different rows cannot overwrite each other's createdTaskId during read-modify-write repair.
      The individual key still precedes the guarded intake fingerprint lock as required.
      */
      releaseParentRecommendationLock = await acquireRecommendationIdempotencyLock(lockProjectId, req.params.id, "parent-mutation");
      releaseRecommendationLock = await acquireRecommendationIdempotencyLock(lockProjectId, req.params.id, req.params.recommendationId);
      // Re-read only after acquiring the recommendation identity lock; this is the queue winner's authority.
      const parent = await scopedStore.getTask(req.params.id).catch(() => null);
      if (!parent || parent.deletedAt) throw notFound("Task not found");
      const completeColumns = await (async () => {
        try {
          const ir = await resolveWorkflowIrForTask(scopedStore, parent.id);
          const columns = columnsWithFlag(ir, "complete");
          return new Set(columns.length > 0 ? columns : ["done"]);
        } catch {
          return new Set(["done"]);
        }
      })();
      if (!completeColumns.has(parent.column)) {
        throw conflict("recommendations are available only on completed tasks");
      }
      const recommendation = parent.recommendations?.find((item) => item.id === req.params.recommendationId);
      if (!recommendation) throw notFound("Recommendation not found");

      const repairLink = async (child: Task): Promise<Task> => {
        try {
          /*
          FNXC:TaskRecommendations 2026-08-08-06:52:
          Route-local promise locks only coordinate one dashboard process. The TaskStore mutation
          takes the project-scoped PostgreSQL advisory lock and re-reads the parent in that same
          transaction, so concurrent dashboard instances cannot overwrite another recommendation
          link after the durable child claim has been created.
          */
          return await scopedStore.linkTaskRecommendation(parent.id, recommendation.id, child.id, completeColumns);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            message === "Recommendation no longer exists"
            || message === "Recommendation is already linked to another task"
            || message === "Recommendations are available only on completed tasks"
          ) {
            throw conflict(message);
          }
          throw error;
        }
      };

      if (recommendation.createdTaskId) {
        if (!/^[A-Z]+-\d+$/.test(recommendation.createdTaskId)) {
          throw conflict("Recommendation link is malformed");
        }
        const linked = await scopedStore.getTask(recommendation.createdTaskId).catch(() => null);
        const linkedArchiveColumns = linked
          ? await archivedColumnsForTask(scopedStore, linked.id)
          : new Set<string>();
        /*
        FNXC:TaskRecommendations 2026-08-08-06:34:
        A prior link is reusable only while its child remains in a live task lane. Archived and
        soft-deleted children are historical records, not an actionable Created result; conflict
        rather than silently resurrecting or linking a second child.

        FNXC:TaskRecommendations 2026-08-09-03:30:
        Archive unavailability uses archivedColumnsForTask (workflow archived trait), not a
        legacy `"archived"` column literal — custom archive-lane boards keep the same rule.
        */
        if (!linked || linked.deletedAt || linkedArchiveColumns.has(linked.column)) {
          throw conflict("Recommendation link points to an unavailable task");
        }
        return res.status(200).json({ task: linked, parent });
      }

      const proposalClaimId = `recommendation:${parent.lineageId ?? parent.id}:${recommendation.id}`;
      /*
      FNXC:TaskRecommendations 2026-08-08-05:41:
      Proposal claims deliberately survive soft deletion to prevent a stale recommendation retry
      from colliding with the unique claim and manufacturing a second child. Read tombstones here
      only to return a conflict; they are never relinked or exposed as live recommendation tasks.
      */
      const existing = (await scopedStore.listTasks({ slim: false, includeArchived: true, includeDeleted: true }))
        .find((task) => task.proposalClaimId === proposalClaimId);
      const existingArchiveColumns = existing
        ? await archivedColumnsForTask(scopedStore, existing.id)
        : new Set<string>();
      /*
      FNXC:TaskRecommendations 2026-08-08-08:44:
      Deterministic reconciliation moves a child to its workflow's archived trait, which may be
      named anything but `archived`. Detect that trait before retry recovery so a custom-workflow
      child reaches the explicit intake re-home rather than being stranded as an unavailable claim.
      */
      const recoverArchivedProposalTask = existing
        && !existing.deletedAt
        && existingArchiveColumns.has(existing.column)
        && typeof existing.sourceMetadata?.deterministicDuplicateOf === "string"
        ? existing
        : undefined;
      if (existing && !recoverArchivedProposalTask) {
        if (existing.deletedAt || existingArchiveColumns.has(existing.column)) throw conflict("Recommendation task is unavailable");
        const repairedParent = await repairLink(existing);
        return res.status(200).json({ task: existing, parent: repairedParent });
      }

      const originalBody = req.body;
      req.body = {
        title: recommendation.title,
        description: recommendation.description,
        source: {
          sourceType: "api",
          sourceParentTaskId: parent.id,
          sourceMetadata: { recommendationId: recommendation.id, recommendationCategory: recommendation.category },
        },
      };
      try {
        await createTaskThroughGuardedIntake(req, res, {
          proposalClaimId,
          recoverArchivedProposalTask,
          onCreated: repairLink,
          responseForCreated: (child, linkedParent) => ({ task: child, parent: linkedParent as Task }),
        });
      } finally {
        req.body = originalBody;
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    } finally {
      releaseRecommendationLock?.();
      releaseParentRecommendationLock?.();
    }
  });

  // Move task to column
  router.post("/tasks/:id/move", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { column, preserveProgress } = req.body;
      /*
      FNXC:WorkflowColumns 2026-07-19-2b:15 (U12 / R2 / R11):
      Validate against the TASK'S WORKFLOW, not the legacy six-id enum. This endpoint rejected
      every workflow-defined column outright — a board built on a custom workflow could not move a
      card into its own `Merging` column, the API answered 400 "Must be one of: triage, todo, ...".
      That is the closed-enum blocker the cutover exists to remove.
      Resolution failure or a v1 (columnless) IR falls back to the legacy set, so the default
      workflow and older definitions behave exactly as before.
      */
      if (typeof column !== "string" || !column) {
        throw badRequest("Invalid column. Expected a non-empty column id.");
      }
      const moveTargetIr = await resolveWorkflowIrForTask(scopedStore, req.params.id).catch(() => undefined);
      const declaresColumns = Array.isArray((moveTargetIr as { columns?: unknown[] } | undefined)?.columns);
      const columnIsValid = moveTargetIr && declaresColumns
        ? workflowHasColumn(moveTargetIr, column)
        : COLUMNS.includes(column as Column);
      if (!columnIsValid) {
        const allowed = moveTargetIr && declaresColumns
          ? ((moveTargetIr as unknown as { columns: Array<{ id: string }> }).columns.map((c) => c.id))
          : [...COLUMNS];
        throw badRequest(`Invalid column. Must be one of: ${allowed.join(", ")}`);
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
          (await scopedStore.getActivePrEntityBySource?.("task", guardTask.id)) ??
          (guardTask.branchContext?.groupId
            ? await scopedStore.getActivePrEntityBySource?.("branch-group", guardTask.branchContext.groupId)
            : null);
        // FNXC:WorkflowResolvedColumns 2026-07-27-16:15 (U10 / R8): position comes from the
        // task's own workflow column order (already resolved above as `moveTargetIr`), falling
        // back to the legacy enum when the workflow cannot place both endpoints.
        const { fromIndex, toIndex } = resolveMoveOrderIndices(moveTargetIr, guardTask.column, moveTarget);
        if (isBackwardMoveBlockedByOpenPr({ fromIndex, toIndex, activePrEntity })) {
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
      /*
      FNXC:WorkflowColumns 2026-07-19-2b:20 (U12 / R2):
      Allocate a worktree when promoting into a WIP column, keyed on the trait rather than the
      literal `in-progress` id. A custom workflow's execution column carries `wip` under its own
      name, and without this it landed in-progress with a null worktree.
      */
      const targetIsWip = moveTargetIr && declaresColumns
        ? columnHasFlag(moveTargetIr, column, "countsTowardWip")
        : LEGACY_WIP_LANES.has(column);
      if (targetIsWip) {
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
      // FNXC:TaskLookup404 2026-07-26-11:45: moving an unknown task id is a 404,
      // not a 500 — classify the miss before the transition-rejection mapping.
      if (isTaskLookupMiss(err)) {
        rethrowTaskApiError(err, req.params.id);
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
      // FNXC:WorkflowColumns 2026-07-27-09:54 (U2 / R9): the
      // "Workflow columns are not enabled" rejection is deleted — its gate was a
      // literal `true`, so promote never took it.
      const settings = await scopedStore.getSettingsFast();
      const existing = await scopedStore.getTask(req.params.id);
      const rootDir = scopedStore.getRootDir();
      const allocateWorktree = existing
        ? (task: Task, reservedNames: Set<string>) =>
            planTaskWorktreePath(task, rootDir, settings.worktreeNaming, reservedNames, settings)
        : undefined;

      /*
      FNXC:WorkflowScheduling 2026-07-25-04:55:
      `{ force: true }` is the operator's explicit "start it anyway" override for
      the `unplanned-for-execution` rejection below — the board offers it in the
      confirm dialog that rejection raises. It waives ONLY the plan/replan gate;
      capacity and slot reservation still arbitrate the move.
      */
      const force = (req.body as { force?: unknown } | undefined)?.force === true;

      const result = await promoteHeldTask(scopedStore, req.params.id, { allocateWorktree }, { force });
      if (!result.released) {
        /*
        FNXC:WorkflowScheduling 2026-07-21-22:31:
        Pre-release Plan Review / unplanned holds are not capacity pressure.
        Map them to a distinct API code so operators are not told the WIP column
        is full when plan-review is still outstanding (FN-8471).
        */
        if (result.rejection === "unplanned-for-execution") {
          throw new ApiError(409, "Task is not ready for execution (plan review or planning still outstanding)", {
            code: "unplanned-for-execution",
            messageKey: "board.rejection.unplannedForExecution",
            retryable: true,
            // Tells the board this rejection has an operator override available.
            forceable: true,
          });
        }
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
      rethrowTaskApiError(err, req.params.id);
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
      const terminalColumns = await resolveTerminalColumnsForTask(scopedStore, task.id);
      if (!terminalColumns.has(task.column)) {
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
          severityAuditLog.warn(
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

      /*
      FNXC:TaskRevert 2026-07-16-00:00:
      FN-8066 records dashboard provenance on the source task only when its changes
      are proven reverted at the base branch HEAD: clean landed git reverts and
      already-reverted outcomes, including autoMerge:false PR-mode results where
      preparation finds nothing left to merge. AI undo, conflict, needsHuman,
      unsupported, and PR-pending outcomes do not stamp this marker because the
      source is not yet reverted at HEAD. This awaited persistence intentionally
      fails the request if it cannot be written; a successful response must have a
      durable badge marker. It does not change the source task lifecycle column.
      */
      const stampReverted = async (revertCommitSha?: string): Promise<void> => {
        await scopedStore.updateTask(task.id, {
          sourceMetadataPatch: {
            revertedAt: new Date().toISOString(),
            ...(revertCommitSha ? { revertedCommitSha: revertCommitSha } : {}),
          },
        });
      };

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
              await stampReverted();
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
          /*
          FNXC:WorkflowResolvedColumns 2026-07-30-17:20:
          The SAME set this route already gated on a few lines up, handed to the service so its
          defence-in-depth check answers the same question. Before this the route resolved terminal lanes
          while the service compared to hardcoded `done`/`archived`, so on a renamed board the route
          admitted the revert and the service refused it — a dead end from an affordance both the UI and
          the route offered.
          */
          revertableColumns: terminalColumns,
          workspaceRootDir: rootDir,
          settings,
          commitAssociationSource: {
            getTaskCommitAssociationsByLineageId: (lineageId: string) =>
              scopedStore.getTaskCommitAssociationsByLineageId(lineageId),
          },
          effectiveAutoMerge: settings.autoMerge,
        });

        if (workspaceResult.mode === "git" && "clean" in workspaceResult && workspaceResult.clean === true) {
          await stampReverted();
        }

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
            await stampReverted();
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
        /*
        FNXC:WorkflowResolvedColumns 2026-07-30-17:20:
        The SAME set this route already gated on a few lines up, handed to the service so its
        defence-in-depth check answers the same question. Before this the route resolved terminal lanes
        while the service compared to hardcoded `done`/`archived`, so on a renamed board the route
        admitted the revert and the service refused it — a dead end from an affordance both the UI and
        the route offered.
        */
        revertableColumns: terminalColumns,
        worktreePath: rootDir,
        baseBranch,
        commitAssociationSource: {
          getTaskCommitAssociationsByLineageId: (lineageId: string) =>
            scopedStore.getTaskCommitAssociationsByLineageId(lineageId),
        },
        effectiveAutoMerge: settings.autoMerge,
        granularity,
      });

      if (result.mode === "git" && "clean" in result && result.clean === true) {
        await stampReverted("revertCommitSha" in result && typeof result.revertCommitSha === "string" ? result.revertCommitSha : undefined);
      }

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
      rethrowTaskApiError(err, req.params.id);
    }
  });

  // Retry failed, stuck-killed, or stranded triage/planning task
  router.post("/tasks/:id/retry", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      const retrySpecificationStatus =
        task.status === "failed" ||
        task.status === "planning" ||
        task.status === "needs-replan" ||
        (task.stuckKillCount ?? 0) > 0;
      /*
      FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
      The INTAKE column, resolved from the task's workflow. `=== "triage"` stopped matching
      for default-workflow cards once the merged lineage dropped that id, so a spec retry on
      a planning card fell through to the generic-retry path below. That path still catches
      it for the merged shape (it keys on `todo` when the workflow declares no `triage`), so
      this was not a stall — but it worked by accident of the two conditions overlapping,
      not because either was right.
      */
      /*
      FNXC:ManualRetry 2026-07-30-02:10 (supersedes the 2026-07-13 gate and #2614's intake resolve):
      The question this branch must answer is "does this card sit where its workflow PLANS?", because
      the yes-branch is DESTRUCTIVE: it stamps needs-replan AND deletes PROMPT.md.

      Two predicates stood in for it and neither answered it. #2614 resolved the INTAKE column, which
      is right for the merged lineage but wrong wherever intake and the planning column differ. The
      older arm asked `!workflowHasColumn(ir, "triage")`, and MEASURED across all 12 builtins: NOT ONE
      plans in `triage`, while SEVEN still declare that column. So for the five that declare `triage`
      AND run every plan node in `todo` — quick-fix, review-heavy, compound-engineering, design,
      legacy-coding — the predicate was FALSE and a planning/needs-replan card sitting in its own
      planning column was refused outright:
        400 "Task is not in a retryable state (current status: needs-replan)"
      The operator had no button at all on a card parked mid-planning. Verified still live on main
      after #2614: 9 of this file's 14 retry tests fail without the change below.

      The mirror-image fault is destructive rather than obstructive: a workflow that plans anywhere
      other than `todo` had a `todo` card's PROMPT.md deleted for a re-plan nobody asked for.

      Ask the graph directly. `workflowPlansInColumn` recognises planning nodes by the semantic markers
      the builtins carry (`config.seam`, an exact `workflowAction` set) with node ids as a backstop.
      */
      const workflowIr = await resolveWorkflowIrForTask(scopedStore, task.id);
      const retrySpecification = retrySpecificationStatus && workflowPlansInColumn(workflowIr, task.column);
      /*
      Narrowing the DESTRUCTIVE branch must not narrow RETRYABILITY — those were one boolean and are
      two concerns. A planning-status card parked outside its planning column would otherwise fail the
      gate below and answer "not in a retryable state", leaving the operator NO button: that trades a
      card which loses its spec for a card nothing can rescue. Such a card stays retryable and takes
      the ordinary, non-destructive execution retry.

      A v1 IR declares neither columns nor nodes, so the placement question is UNANSWERABLE rather than
      answered "no"; treating that silence as "past planning" is what produced a 400 for a v1 planning
      card. Scoped to pre-WIP columns otherwise, so no in-progress/in-review status gains a retry path
      it did not have.
      */
      let strandedSpecificationRetry = false;
      if (retrySpecificationStatus && !retrySpecification) {
        if (!workflowDeclaresColumnModel(workflowIr)) {
          /*
          FNXC:ManualRetry 2026-07-30-03:10 (greptile #2621) DELIBERATE-LITERAL:
          This branch runs ONLY when the IR declares no columns and no nodes (a v1 workflow), so there
          is no role to resolve — `resolveLifecycleColumns` returns nothing and the legacy
          pre-implementation ids are the only pre-WIP signal in existence here. Converting it is not
          possible, not merely unfinished; the sibling `else` two lines down is the trait path for every
          IR that CAN answer.

          Marked because this raised the census count 22 -> 23 when #2621 merged, leaving `--strict`
          red on main. A rise that is genuinely correct belongs at the site, not in the baseline.

          Still PRE-WIP ONLY. Admitting every column here was a real regression: a v1 workflow with a
          planning/needs-replan status on an `in-progress` or `in-review` card would be admitted, and
          the generic branch then clears worktree/branch/retry counters and rebounds the card — losing
          live execution or review state that was never in question. A v1 IR yields no roles, so the
          legacy pre-implementation ids are the only pre-WIP signal available.

          FNXC:WorkflowLifecycleColumns 2026-07-29-23:40 DELIBERATE-LITERAL: the v1-IR arm only.
          A v1 workflow declares no roles, so there is no trait to read — this is not an unconverted
          guard, it is the answer for IRs that cannot express the question. The v2 branch below
          resolves it properly. Retires when v1 IRs do.
          */
          strandedSpecificationRetry = task.column === "triage" || task.column === "todo";
        } else {
          const lifecycle = resolveLifecycleColumns(workflowIr);
          strandedSpecificationRetry = lifecycle !== undefined
            && (task.column === lifecycle.intake || task.column === lifecycle.hold);
        }
      }
      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-04:15 (fleet: register-task-workflow-routes.ts):
      Resolved ONCE for the whole retry handler and reused by all three review checks below, so they
      cannot disagree about which column is the review lane.
      */
      const retryReviewColumns = await resolveReviewColumnsForTask(scopedStore, task.id);
      const isInReviewStatusNone =
        retryReviewColumns.has(task.column) && (task.status === null || task.status === undefined);
      const hasIncompleteSteps = task.steps.some(
        (s: { status: string }) => s.status === "pending" || s.status === "in-progress",
      );
      // FN-4130 / PR #59 follow-up: zero-step review failures with no merge attempts
      // (`mergeRetries ?? 0 === 0`) failed during execution, not merge finalization.
      const isExecutionFailureInReview =
        hasIncompleteSteps || (task.steps.length === 0 && (task.mergeRetries ?? 0) === 0);
      const isInReviewExecutionStall = isInReviewStatusNone && isExecutionFailureInReview;
      const isInReviewMergeRetryStall = isInReviewStatusNone && (task.mergeRetries ?? 0) > 0;
      /*
      FNXC:MergeReliability 2026-07-15-21:45 (FN-8004 follow-up):
      An orphaned merge-active stamp used to be un-retryable BY HAND: this gate rejected every
      merge-active status ("Task is not in a retryable state (current status: landing)"), so when a
      merger died mid-flight — crash, engine restart, operator SIGTERM — the operator's escape hatch
      was blocked exactly when it was needed, and the only recourse was waiting out self-healing's
      recoverStaleMergingStatus sweep. Observed on FN-8004: a killed merge left `landing` stamped and
      manual Retry 400'd for the full sweep delay.

      `isStaleMergeActiveStatus` and its configured age floor are the SAME inputs that sweep uses, so
      the manual path can never be looser than the automatic one. A genuinely RUNNING merge stays protected: it holds the
      in-process merge lease (activeMergeTaskId) and refreshes `updatedAt` each phase, so it fails
      both staleness checks and Retry still refuses it.

      This feeds `isInReviewRetry` rather than only the gate: a bare gate bypass would fall through
      to the generic retry branch below and move a fully-executed task to `todo`, re-running finished
      work. Routing it through isInReviewRetry lands it on the merge-retry branch (clear status/error,
      reset mergeRetries, STAY in in-review) — identical to what the operator's Retry button does for
      a failed merge. A stale-stamped task that also has incomplete steps still routes to the
      execution branch via isExecutionFailureInReview, which is the correct handling for that case.
      */
      const selfHealingManager = _resolveSelfHealingManager(scopedStore);
      const isStaleMergeActiveRetry =
        retryReviewColumns.has(task.column) &&
        isStaleMergeActiveStatus(task, {
          activeMergeTaskId: selfHealingManager?.getActiveMergeTaskId?.() ?? null,
          minAgeMs: selfHealingManager?.getStaleMergingStatusMinAgeMs?.(),
        });
      const isInReviewRetry =
        retryReviewColumns.has(task.column) &&
        (task.status === "failed" ||
          task.status === "stuck-killed" ||
          isInReviewExecutionStall ||
          isInReviewMergeRetryStall ||
          isStaleMergeActiveRetry);
      /*
      FNXC:MissingWorktreeRetry 2026-07-10-18:32:
      Dashboard retry must support the upstream #1992 signature where the task is stranded in a merge-active status but the durable failure is an unusable worktree session-start assertion. Only that classifier bypasses the merge-active status gate.
      */
      /* FNXC:WorkflowLifecycleColumns 2026-08-02-12:15 (PR #2728 review): the classifier now takes the set
         this route already resolved, instead of falling back to its own literal — the gate above and this
         delegate must agree about which columns are review. */
      const isMissingWorktreeSessionRetry = isInReviewMissingWorktreeSessionStartFailure(task, retryReviewColumns.has(task.column));
      if (task.status !== "failed" && task.status !== "stuck-killed" && !retrySpecification && !strandedSpecificationRetry && !isInReviewRetry && !isMissingWorktreeSessionRetry) {
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
      // FNXC:TaskWedgeNotifications 2026-08-10-20:15: dashboard Retry is explicit operator intervention, so it clears the spent generic-terminal budget.
      await scopedStore.resetTerminalFailureAutoRecoveryBudget(req.params.id);

      if (isMissingWorktreeSessionRetry) {
        /*
        FNXC:WorkflowColumns 2026-07-19-11:05 (U12 review):
        Resolve the rebound destination BEFORE logging so the audit entry reports the real
        trait-derived column instead of a hardcoded "todo", which misleads on custom boards.
        */
        const reboundColumn = await resolveReboundColumnForTask(scopedStore, req.params.id);
        await clearRebuiltSpecWorkflowPins(scopedStore, req.params.id);
        await scopedStore.updateTask(req.params.id, {
          status: null,
          error: null,
          worktree: null,
          branch: null,
          sessionFile: null,
          ...autoPauseClearPatch,
          ...buildManualRetryResetPatch({ resetMergeRetries: true }),
        });
        await scopedStore.logEntry(req.params.id, `Retry requested from dashboard (unusable worktree session-start recovery → ${reboundColumn}, preserving progress${retryLogSuffix})`);
        const updated = await scopedStore.moveTask(req.params.id, reboundColumn, { preserveProgress: true });
        res.json(updated);
        return;
      }

      // In-review retry: distinguish between execution failures (incomplete steps)
      // and merge failures (all steps done).
      if (isInReviewRetry) {
        if (isExecutionFailureInReview) {
          /*
          FNXC:WorkflowRetry 2026-06-29-02:18:
          Dashboard retry for an in-review execution failure re-enters the workflow graph from parse/execution, so it must clear persisted foreach step-instance pins. Otherwise a stale pin from the failed run makes the retry hit the same parse pin-mismatch immediately.
          */
          /*
          FNXC:WorkflowColumns 2026-07-19-11:05 (U12 review):
          Resolve the rebound destination BEFORE logging so the audit entry reports the real
          trait-derived column instead of a hardcoded "todo", which misleads on custom boards.
          */
          const reboundColumn = await resolveReboundColumnForTask(scopedStore, req.params.id);
          await clearRebuiltSpecWorkflowPins(scopedStore, req.params.id);
          await scopedStore.updateTask(req.params.id, {
            status: null,
            error: null,
            ...autoPauseClearPatch,
            ...buildManualRetryResetPatch(),
          });
          await scopedStore.logEntry(
            req.params.id,
            isInReviewExecutionStall
              ? `Retry requested from dashboard (stranded in-review execution retry → ${reboundColumn}, preserving progress${retryLogSuffix})`
              : `Retry requested from dashboard (execution failure in-review → ${reboundColumn}, preserving progress${retryLogSuffix})`,
          );
          const updated = await scopedStore.moveTask(req.params.id, reboundColumn, { preserveProgress: true });
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
      await clearRebuiltSpecWorkflowPins(scopedStore, req.params.id);

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
      const reboundColumn = await resolveReboundColumnForTask(scopedStore, req.params.id);
      const updated = await scopedStore.moveTask(req.params.id, reboundColumn);
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowTaskApiError(err, req.params.id);
    }
  });

  /*
   * FNXC:ReviewLaneBypass 2026-07-09-00:00:
   * Operator/privileged escape hatch for a card stranded in `in-review` solely
   * by a failed pre-merge review lane (Runfusion/Fusion#1946 no-verdict
   * dispatch defect). Mirrors the `/tasks/:id/retry` route shape but delegates
   * all eligibility/mutation logic to `store.bypassFailedPreMergeReviewStep`
   * (FN-7720). This route is intentionally NOT part of the executor/reviewer
   * agent tool surface — dashboard/operator only.
   */
  router.post("/tasks/:id/bypass-review", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { reason, actor } = (req.body ?? {}) as { reason?: unknown; actor?: unknown };
      if (typeof reason !== "string" || reason.trim().length === 0) {
        throw badRequest("reason is required to bypass a failed pre-merge review step");
      }
      /*
      FNXC:ApprovalDecisionAuthority 2026-07-26-16:20:
      The recorded bypass actor is derived SERVER-SIDE. The daemon bearer token is a
      single shared operator secret, so the only honest attribution for an HTTP bypass is
      the synthetic dashboard operator; a body-supplied `actor` is client-claimed,
      unverifiable identity and is carried as advisory display metadata only — it can no
      longer replace the attribution (an agent could previously stamp any name into
      `bypassedBy`). Format: `dashboard-operator` or `dashboard-operator (as "<name>")`.
      Mandatory `reason` stays mandatory.
      */
      const advisoryName = typeof actor === "string" && actor.trim().length > 0 ? actor.trim() : undefined;
      const resolvedActor = advisoryName && advisoryName !== "dashboard-operator"
        ? `dashboard-operator (as ${JSON.stringify(advisoryName)})`
        : "dashboard-operator";
      const updated = await scopedStore.bypassFailedPreMergeReviewStep(req.params.id, {
        reason: reason.trim(),
        actor: resolvedActor,
      });
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        throw notFound(message);
      }
      if (message.includes("Cannot bypass review lane") || message.includes("requires a non-empty reason")) {
        throw conflict(message);
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
      await clearRebuiltSpecWorkflowPins(scopedStore, req.params.id);

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

      const resetColumn = await resolveReboundColumnForTask(scopedStore, req.params.id);
      await scopedStore.moveTask(req.params.id, resetColumn);
      await clearRebuiltSpecWorkflowPins(scopedStore, req.params.id);
      let updated = await scopedStore.getTask(req.params.id);
      if (!updated) {
        throw notFound(`Task ${req.params.id} not found after reset`);
      }

      /*
      FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
      Verify against the column the reset actually TARGETED. The mover two lines up already
      resolves `resetColumn` from the task's workflow, but both post-reset checks compared
      against the literal `todo` — so on any workflow whose rebound column is not `todo`
      (Coding (Ideas), any custom or renamed lineage) a reset that SUCCEEDED was reported
      as a "limbo state" conflict. The mover and its own verification disagreed about
      where the card was supposed to land.
      */
      const needsDriftCorrection = updated.column !== resetColumn
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
        /*
        Built as a named const, not an inline literal: `updateTask`'s patch type does not
        declare `column`, and the original code only compiled because a variable reference
        skips excess-property checking. Keeping that shape preserves the existing runtime
        behaviour exactly while making the column follow the resolved rebound target.
        */
        const driftCorrection = { ...RESET_DRIFT_CORRECTION_FIELDS, column: resetColumn };
        await scopedStore.updateTask(req.params.id, driftCorrection);
        await scopedStore.logEntry(
          req.params.id,
          `Auto-corrected reset drift after moveTask — normalized task back to ${resetColumn} with cleared worktree/branch bindings`,
          JSON.stringify(offendingSnapshot),
        );
        await emitResetDriftAudit(scopedStore, req.params.id, offendingSnapshot);
        updated = await scopedStore.getTask(req.params.id);
        if (!updated) {
          throw notFound(`Task ${req.params.id} not found after reset drift correction`);
        }
      }

      // Same target as the drift check above: the resolved rebound column, not `todo`.
      if (updated.column !== resetColumn || (updated.worktree ?? null) !== null || (updated.branch ?? null) !== null) {
        throw conflict(
          `Reset refused to return task ${req.params.id} in limbo state (${updated.column}, branch=${updated.branch ?? "null"}, worktree=${updated.worktree ?? "null"})`,
        );
      }

      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowTaskApiError(err, req.params.id);
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
      const status = isTaskLookupMiss(errorWithCode) ? 404 : 500;
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
      const status = isTaskLookupMiss(errorWithCode) ? 404
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
      /*
      FNXC:ArchiveConfirmGate 2026-07-26-16:30:
      Bulk archive sweeps every done task in one call, yet had no confirmation while the
      single-task reset (a comparable board-wide-impact mutation) already requires
      `{ confirm: true }`. An agent or stray script hitting this route could silently
      empty the Done column. Require the same explicit `{ confirm: true }` body; the
      dashboard's "Archive all done" button sends it after its user-facing confirm.
      */
      const { confirm: confirmed } = (req.body ?? {}) as { confirm?: boolean };
      if (confirmed !== true) {
        throw badRequest(
          "This operation archives every done task. Pass { \"confirm\": true } in the request body to proceed.",
        );
      }
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
   * Body: { taskIds: string[], modelProvider?: string | null, modelId?: string | null, validatorModelProvider?: string | null, validatorModelId?: string | null, planningModelProvider?: string | null, planningModelId?: string | null, thinkingLevel?: ThinkingLevel | null }
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
        thinkingLevel,
        credentialInstanceId,
        validatorCredentialInstanceId,
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

      // Validate that at least one model field, thinking level, or node override is being updated
      const hasExecutorModel = modelProvider !== undefined || modelId !== undefined;
      const hasValidatorModel = validatorModelProvider !== undefined || validatorModelId !== undefined;
      const hasPlanningModel = planningModelProvider !== undefined || planningModelId !== undefined;
      const hasNodeId = nodeId !== undefined;
      const hasThinkingLevel = thinkingLevel !== undefined;
      const hasCredentialInstance = credentialInstanceId !== undefined || validatorCredentialInstanceId !== undefined;
      if (!hasExecutorModel && !hasValidatorModel && !hasPlanningModel && !hasNodeId && !hasThinkingLevel && !hasCredentialInstance) {
        throw badRequest("At least one model field, thinkingLevel, or nodeId must be provided");
      }

      if (nodeId !== undefined && nodeId !== null && typeof nodeId !== "string") {
        throw badRequest("nodeId must be a string, null, or undefined");
      }
      if ((credentialInstanceId !== undefined && credentialInstanceId !== null && typeof credentialInstanceId !== "string")
        || (validatorCredentialInstanceId !== undefined && validatorCredentialInstanceId !== null && typeof validatorCredentialInstanceId !== "string")) {
        throw badRequest("credential instance IDs must be strings, null, or undefined");
      }
      if (thinkingLevel !== undefined && thinkingLevel !== null && (typeof thinkingLevel !== "string" || !THINKING_LEVELS.includes(thinkingLevel as ThinkingLevel))) {
        throw badRequest(`thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}, null, or undefined`);
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
          if (isTaskLookupMiss(err) || (err instanceof Error ? err.message : String(err)).includes("not found")) {
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
        thinkingLevel?: ThinkingLevel | null;
        credentialInstanceId?: string | null;
        validatorCredentialInstanceId?: string | null;
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
      /*
      FNXC:Settings-ThinkingLevel 2026-07-12-00:00:
      Bulk task model edits can now set or clear one executor-scoped thinkingLevel across the selected tasks, reusing the existing batch route instead of inventing a dashboard-only control that persists nowhere.
      */
      if (thinkingLevel !== undefined) {
        updates.thinkingLevel = thinkingLevel as ThinkingLevel | null;
      }
      /*
      FNXC:TaskBulkModels 2026-08-01-10:34:
      Bulk model editing must persist explicit credential-instance choices and clear them on Default. Omitting unchanged lanes preserves the no-change sentinel rather than rewriting task overrides.
      */
      if (credentialInstanceId !== undefined) updates.credentialInstanceId = credentialInstanceId;
      if (validatorCredentialInstanceId !== undefined) updates.validatorCredentialInstanceId = validatorCredentialInstanceId;

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
      if (isTaskLookupMiss(err)) {
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
      if (isTaskLookupMiss(err)) {
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
      if (isTaskLookupMiss(err)) {
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
      if (isTaskLookupMiss(err)) {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  /**
   * GET /api/tasks/:id/runtime-fallback
   * Return the most recent "session:runtime-resolved" run-audit event for
   * this task, normalized for the runtime-fallback badge/toast affordance.
   *
   * `showFallbackBadge` is true only when the most recent event has
   * `wasConfigured === false` AND a non-empty configured `runtimeHint` — a
   * missing hint (no runtime was ever configured) is not a misconfiguration
   * and must not surface a badge. Older fallback events are superseded by
   * any later successful resolution because only the single most recent
   * event (limit: 1, store-ordered most-recent-first) is considered.
   *
   * Response: TaskRuntimeFallbackResponse (see routes.ts)
   */
  router.get("/tasks/:id/runtime-fallback", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const taskId = req.params.id;

      // Verify task exists so callers get a clean 404 instead of an empty
      // "no event yet" response for a nonexistent task ID.
      await scopedStore.getTask(taskId);

      const [latest] = await scopedStore.getRunAuditEventsAsync({
        taskId,
        mutationType: "session:runtime-resolved",
        limit: 1,
      });

      if (!latest) {
        res.json({
          taskId,
          hasEvent: false,
          wasConfigured: null,
          runtimeHint: null,
          reason: null,
          eventId: null,
          timestamp: null,
          showFallbackBadge: false,
        });
        return;
      }

      const metadata = latest.metadata ?? {};
      const wasConfigured = metadata.wasConfigured === true;
      const runtimeHintRaw = typeof metadata.runtimeHint === "string" ? metadata.runtimeHint.trim() : "";
      const runtimeHint = runtimeHintRaw.length > 0 ? runtimeHintRaw : null;
      const reason = typeof metadata.reason === "string" ? metadata.reason : null;

      res.json({
        taskId,
        hasEvent: true,
        wasConfigured,
        runtimeHint,
        reason,
        eventId: latest.id,
        timestamp: latest.timestamp,
        showFallbackBadge: wasConfigured === false && runtimeHint !== null,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (isTaskLookupMiss(err)) {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err);
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

  /*
  FNXC:TaskVerificationStatus 2026-07-30-00:00:
  FN-8296 exposes the executor-owned verification read model through a scoped
  route. The client polls this record independently because it is not a task-row
  mutation and should not fabricate a board update just to refresh status.
  */
  router.get("/tasks/:id/verification-request", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      await scopedStore.getTask(req.params.id);
      res.json(await scopedStore.getTaskVerificationRequestAsync(req.params.id));
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowTaskApiError(err, req.params.id, "Failed to read task verification status");
    }
  });

  /*
  FNXC:TaskDetailPlan 2026-08-05-04:05:
  This literal route precedes /tasks/:id so Express cannot capture `prompt` as a task id.
  Definition polling gets only identity plus PROMPT.md and cannot replace lifecycle or workflow state.
  */
  router.get("/tasks/:id/prompt", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      res.json(task.prompt === undefined ? { id: task.id } : { id: task.id, prompt: task.prompt });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (isTaskLookupMiss(err)) throw notFound(`Task ${req.params.id} not found`);
      rethrowAsApiError(err, "Internal server error");
    }
  });

  /*
  FNXC:SpecLock 2026-08-09-12:34:
  Task Detail reads retained structural evidence from the store rather than recomputing it in the
  browser, keeping displayed alignment identical to the execution-time evaluator.
  */
  router.get("/tasks/:id/spec-lock", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      const [latestLock, activeLock, currentPlan, latestReport, locks, currentPlans, reports] = await Promise.all([
        scopedStore.getLatestSpecLock(req.params.id),
        scopedStore.getActiveSpecLock(req.params.id),
        scopedStore.getLatestCurrentPlanEvidence(req.params.id),
        scopedStore.getLatestSpecDriftReport(req.params.id),
        scopedStore.listSpecLocks(req.params.id),
        scopedStore.listCurrentPlanEvidence(req.params.id),
        scopedStore.listSpecDriftReports(req.params.id),
      ]);
      /*
      FNXC:SpecDrift 2026-08-09-19:19:
      Route readers expose the active lock separately and never promote a historical clean report
      after a prompt rewrite or re-lock. The stale row remains in immutable history for audit.
      */
      const report = isCurrentSpecDriftReport(latestReport, latestLock, currentPlan, task.approvedPlanFingerprint) ? latestReport : undefined;
      res.json({ latestLock: latestLock ?? null, activeLock: activeLock ?? null, currentPlan: currentPlan ?? null, report: report ?? null, latestReport: latestReport ?? null, history: { locks, currentPlans, reports } });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (isTaskLookupMiss(err)) throw notFound(`Task ${req.params.id} not found`);
      rethrowAsApiError(err, "Internal server error");
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
      /*
      FNXC:TaskLookup404 2026-07-26-11:55 (supersedes the ENOENT-only note):
      A task that genuinely does not exist → 404; any other error (JSON parse
      failure from a concurrent partial write, transient FS error) → 500 so
      clients can retry.

      The previous check was `code === "ENOENT"` alone, a file-backed-storage-era
      leftover. In Postgres/backend mode nothing on the task read path sets an
      errno code, so EVERY unknown/missing/soft-deleted task id fell through to
      500. `isTaskLookupMiss` matches the typed `TaskNotFoundError` from
      `@fusion/core` first and keeps ENOENT as a legacy fallback.
      */
      if (isTaskLookupMiss(err)) {
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
      const updated = await scopedStore.pauseTask(req.params.id, true, undefined, { userPaused: true });
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowTaskApiError(err, req.params.id);
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
      rethrowTaskApiError(err, req.params.id);
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
      rethrowTaskApiError(err, req.params.id);
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
      rethrowTaskApiError(err, req.params.id);
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
      rethrowTaskApiError(err, req.params.id);
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
      const entries = await getPlannerInterventionTimeline(scopedStore, req.params.id);
      res.json({ entries });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowTaskApiError(err, req.params.id);
    }
  });

  router.post("/tasks/:id/recover-branch-binding", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (!task) {
        throw notFound(`Task ${req.params.id} not found`);
      }
      const prStatusReviewColumns = await resolveReviewColumnsForTask(scopedStore, task.id);
      if (!prStatusReviewColumns.has(task.column)) {
        /*
        FNXC:WorkflowLifecycleColumns 2026-08-02-05:10 (the operator-facing half of #2713's conversion):
        THE MESSAGE NAMES THE BOARD'S OWN COLUMNS. The gate resolves review by trait, but the 400 still
        said `in-review` — a column the operator's board may not have. Being told your card must be in a
        column that does not exist is worse than a wrong guard: a wrong guard is a bug report, a wrong
        column name sends the operator looking for something that was deleted.
        */
        const expected = [...prStatusReviewColumns].map((column) => `'${column}'`).join(" or ");
        throw badRequest(`Task must be in ${expected} to recover branch binding`);
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
      rethrowTaskApiError(err, req.params.id);
    }
  });

  // Approve plan for a task in awaiting-approval status
  router.post("/tasks/:id/approve-plan", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const updated = await scopedStore.withPlanningLifecycleLock(req.params.id, async () => {
        /*
         * FNXC:PlanningDependencyReseed 2026-08-04-06:35 FN-8768:
         * The task read belongs inside the same lifecycle lock used by dependency mutation.
         * Otherwise approval can validate an old hold, wait for dependency re-seed to publish
         * needs-replan, and then erase that newer state.
         */
        const task = await scopedStore.getTask(req.params.id);

        /*
        FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — P0, post-#2515):
        Resolve the workflow's INTAKE column; do not name `triage`. #2515 removed `triage`
        from the default lineage — the single pre-implementation column is now id `todo`
        displayed as "Planning" — so comparing the card's column against the legacy
        `triage` id became TRUE for every
        default-workflow card and this route rejected all of them. A card parked
        `awaiting-approval` could not be approved OR rejected (same guard below), i.e. it
        was STUCK with no operator action able to release it. The guard did not stop
        firing; it started firing on everything.
        */
        const { approvalColumn: approveColumn } = await resolvePlanApprovalColumnsForTask(scopedStore, task);
        /*
        The resolved column ONLY — the legacy-`triage` disjunct this comment
        used to justify is gone (PR #2614 review — greptile: the comment outlived the code).
        It was a belt-and-braces widening added with the P0 fix, on the theory that a card
        might still be sitting in `triage`. Nothing shipped declares that column since
        #2515, so the disjunct only widened what the guard accepts, and re-adding it changed
        no test in either direction. A guard that accepts a column no workflow declares is
        not caution, it is an unreachable branch that reads like a requirement.
        */
        if (task.status !== "awaiting-approval") {
          throw badRequest("Task must have status 'awaiting-approval' to approve plan");
        }
        const reboundColumn = await resolveReboundColumnForTask(scopedStore, task.id);
        /*
         * FNXC:PlanReviewReplan 2026-08-04-06:35 FN-8768:
         * A split-column approval keeps the hold set while moving to rebound. Accept that lane on
         * retry so a failure after the move cannot strand a safely blocked partial decision.
         */
        if (task.column !== approveColumn && task.column !== reboundColumn) {
          throw badRequest(`Task must be in the '${approveColumn}' column to approve plan`);
        }
        // FNXC:ReleaseAuthorizationGate 2026-07-09-00:00:
        // The triage release-authorization gate was removed (it over-fired and stranded
        // ordinary tasks). The approve-plan guard that refused any task carrying the legacy
        // awaitingApprovalReason === "release-authorization" is gone too, so tasks parked by
        // the old gate can now be approved normally instead of staying stuck with no exit.

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
        let approvedPrompt: string | undefined;
        try {
          const { readFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
          const promptText = await readFile(promptPath, "utf8");
          approvedPrompt = promptText;
          approvedPlanFingerprint = computePlanApprovalFingerprint(promptText);
        } catch {
          /*
          FNXC:SpecLockApproval 2026-08-09-20:04:
          Manual approval is a release boundary, so an unreadable PROMPT.md cannot fall back to
          clearing a stale fingerprint and releasing un-lockable work. Keep the existing hold until
          the operator restores a readable, structurally comparable plan that can be locked.
          */
          throw conflict("Cannot approve plan: PROMPT.md must be readable to create the immutable spec lock");
        }

        /*
        FNXC:PlanReviewApproval 2026-08-04-00:26:
        Manual approval after the revision cap is durable evidence that the final REVISE was
        accepted. Persist the audited bypass with the hold clear so no consumer can observe only
        half of the operator decision and enqueue another Plan Review.
        */
        let approvedWorkflowStepResults: Task["workflowStepResults"] | undefined;
        if (task.awaitingApprovalReason === "plan-review-replan-cap") {
          const results = [...(task.workflowStepResults ?? [])];
          let reviewIndex = -1;
          for (let index = results.length - 1; index >= 0; index -= 1) {
            const result = results[index];
            if (
              result.workflowStepId === PLAN_REVIEW_GROUP_ID
              && (result.status === "failed" || result.status === "advisory_failure")
              && result.verdict === "REVISE"
            ) {
              reviewIndex = index;
              break;
            }
          }
          if (reviewIndex === -1) {
            const alreadyBypassed = results.some((result) =>
              result.workflowStepId === PLAN_REVIEW_GROUP_ID
              && result.status === "skipped"
              && result.bypassedBy === "dashboard-operator"
              && result.bypassedFromVerdict === "REVISE"
            );
            if (!alreadyBypassed) {
              throw conflict("Cannot approve exhausted Plan Review: no failed REVISE result is available to override");
            }
          } else {
            const prior = results[reviewIndex];
            const bypassed = {
              ...prior,
              status: "skipped" as const,
              bypassedBy: "dashboard-operator",
              bypassedAt: new Date().toISOString(),
              bypassReason: "Approved after Plan Review did not converge",
              bypassedFromStatus: prior.status,
              bypassedFromVerdict: prior.verdict,
            };
            delete bypassed.verdict;
            results[reviewIndex] = bypassed;
          }
          approvedWorkflowStepResults = results;
        }

        /*
        FNXC:SpecLock 2026-08-09-17:37:
        Validate an exhausted Plan Review before attempting persistence. A malformed cap state must
        retain its established conflict response, while every valid release still locks under this fence.
        */
        if (approvedPlanFingerprint && approvedPrompt) {
          await scopedStore.lockCurrentPlanWhilePlanningLocked(task.id, approvedPlanFingerprint, approvedPrompt);
        }

        const approvalPatch = {
          status: null,
          approvedPlanFingerprint: approvedPlanFingerprint ?? null,
          ...(approvedWorkflowStepResults ? { workflowStepResults: approvedWorkflowStepResults } : {}),
        } satisfies Parameters<TaskStore["updateTask"]>[1];

        if (task.column !== reboundColumn) {
          /*
           * FNXC:PlanReviewReplan 2026-08-04-06:35 FN-8768:
           * Persist the decision evidence while the approval hold remains set,
           * then preserve both across the rebound. Every interruption point is
           * therefore non-schedulable and retryable; the final update below is
           * the only operation that releases the hold.
           */
          await scopedStore.updateTask(task.id, {
            ...approvalPatch,
            status: "awaiting-approval",
          });
          await scopedStore.moveTask(task.id, reboundColumn, {
            preserveStatus: true,
            workflowMoveSource: "plan-approval",
          });
        } else {
          // Preserve the historical same-column move behavior and its guards.
          await scopedStore.moveTask(task.id, reboundColumn);
        }
        /*
         * FNXC:PlanApproval 2026-08-03-18:53:
         * Approval must clear the durable awaiting-approval hold with TaskStore's explicit
         * null sentinel; undefined omits a field from the patch. Persist the current plan's
         * fingerprint, or explicitly clear a prior fingerprint when PROMPT.md was unreadable,
         * so a stale plan can never bypass a later manual approval gate.
         */
        const approved = await scopedStore.updateTask(task.id, approvalPatch);
        /*
        FNXC:SpecDrift 2026-08-09-07:36:
        Publish the deterministic report before the approval handoff seeds graph execution. A
        missing/unreadable PROMPT.md yields an unavailable report rather than an unexamined release.
        */
        await scopedStore.reconcileSpecDriftWhilePlanningLocked(approved);
        /*
         * FNXC:PlanApprovalDispatch 2026-08-05-01:57:
         * Clearing awaiting-approval is only the first half of the operator decision. Resume the
         * graph through the public engine seam while the planning lifecycle fence is still held so
         * Plan Review creates its own runnable continuation and later capacity evidence. The route
         * must never mark review passed or create a capacity continuation on the operator's behalf.
         */
        const approvedWorkflow = await resolveWorkflowIrForTask(scopedStore, approved.id);
        const handoff: ApprovedPlanReviewHandoffResult = await resumeApprovedPlanReviewHandoff(
          scopedStore,
          approved,
          approvedWorkflow,
        );
        // Keep the typed handoff result local: recovery owns retry after a post-approval seed failure.
        void handoff;
        // Activity logging is secondary to the now-durable decision. Do not turn
        // a successful approval into a 500 if the bounded log append is unavailable.
        await scopedStore.logEntry(task.id, "Plan approved by user").catch((error) => {
          severityAuditLog.warn(`Failed to record plan approval activity for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
        });
        return approved;
      });

      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = isTaskLookupMiss(errorWithCode) ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Reject plan for a task in awaiting-approval status
  router.post("/tasks/:id/reject-plan", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const updated = await scopedStore.withPlanningLifecycleLock(req.params.id, async () => {
        /*
         * FNXC:PlanningDependencyReseed 2026-08-04-06:35 FN-8768:
         * Match approval's locked fresh-read invariant: a stale reject must not clear needs-replan.
         */
        const task = await scopedStore.getTask(req.params.id);

        /*
         * FNXC:WorkflowResolvedColumns 2026-08-04-06:35 FN-8768:
         * Match approve-plan by resolving the workflow-owned approval column rather than naming
         * legacy `triage`; exhausted review may deliberately park outside intake.
         */
        const { approvalColumn: rejectColumn, intakeColumn } = await resolvePlanApprovalColumnsForTask(scopedStore, task);
        const retryingPartialCapRejection = task.awaitingApprovalReason === "plan-review-replan-cap"
          && task.column === intakeColumn;
        if (task.column !== rejectColumn && !retryingPartialCapRejection) {
          throw badRequest(`Task must be in the '${rejectColumn}' column to reject plan`);
        }
        if (task.status !== "awaiting-approval") {
          throw badRequest("Task must have status 'awaiting-approval' to reject plan");
        }
        // FNXC:ReleaseAuthorizationGate 2026-07-09-00:00:
        // Release-authorization gate removed — see the approve-plan handler above. A task
        // carrying the legacy release-authorization hold can now be rejected normally.

        // Log the rejection
        await scopedStore.logEntry(task.id, "Plan rejected by user", "Specification will be regenerated");

        /*
         * FNXC:PlanApproval 2026-08-03-19:03:
         * Remove PROMPT.md before releasing the approval hold. If removal fails, the rejected
         * plan must remain blocked rather than becoming schedulable with rejected content.
         */
        const { rm } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
        await rm(promptPath, { force: true });

        if (task.column !== intakeColumn) {
          /*
           * FNXC:PlanReviewReplan 2026-08-04-06:35 FN-8768:
           * Keep awaiting-approval durable while a split-column cap park is rehomed to planning
           * intake. If the final clear fails, the safely blocked intake row can retry this route;
           * no interruption exposes rejected content to planning or execution.
           */
          await scopedStore.moveTask(task.id, intakeColumn, {
            preserveStatus: true,
            workflowMoveSource: "plan-approval",
          });
        }

        // Clear status to return to normal triage state
        /*
         * FNXC:PlanApproval 2026-07-04-22:41:
         * FN-7569 — clear any previously-recorded approval fingerprint alongside the status
         * clear and PROMPT.md removal, so the regenerated plan is always treated as new and
         * requires fresh manual approval (it must never inherit the rejected plan's fingerprint).
         */
        await scopedStore.updateTask(task.id, { status: null, approvedPlanFingerprint: null });
        return await scopedStore.getTask(task.id);
      });
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = isTaskLookupMiss(errorWithCode) ? 404 : 500;
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
      // Intake column, resolved from the task's workflow (#2515 removed `triage` from
      // the default lineage, so the literal rejected every default-workflow card).
      const refineIntakeColumn = await resolveIntakeColumnForTask(scopedStore, task.id);
      if (task.column !== refineIntakeColumn) {
        throw badRequest(`Task must be in the '${refineIntakeColumn}' column`);
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
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-23:45 (batch-core):
      "Is this DEPENDENCY finished?" — a membership question about the DEPENDENCY's own workflow, not
      the depending task's. Dependencies can run a different workflow, so the set is resolved per
      `dependencyId` rather than once for the parent; `resolveWorkflowIrForTask` is cached per store,
      so this is a map lookup after the first task on a given workflow.

      Keyed on the literal pair, a dependency finishing in a renamed complete lane read as NOT done,
      and the detail panel showed a satisfied dependency as still blocking — an operator staring at a
      card that looks stuck behind work that is demonstrably finished.

      `resolveTerminalColumnsForTask` already owns the arity and the degraded fallback (legacy pair
      when the IR cannot be read, which also covers a v1-upgraded workflow whose synthesized columns
      carry no traits), so this is a call, not a second copy of the reasoning.
      */
      const dependencyDetails = await Promise.all((task.dependencies ?? []).map(async (dependencyId) => {
        try {
          const depTask = await scopedStore.getTask(dependencyId);
          const depTerminal = await resolveTerminalColumnsForTask(scopedStore, dependencyId);
          return { id: dependencyId, exists: true, column: depTask.column, done: depTerminal.has(depTask.column) };
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
      const status = isTaskLookupMiss(errorWithCode) ? 404 : 500;
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
      // Intake column, resolved from the task's workflow (#2515 removed `triage` from
      // the default lineage, so the literal rejected every default-workflow card).
      const refineIntakeColumn = await resolveIntakeColumnForTask(scopedStore, task.id);
      if (task.column !== refineIntakeColumn) {
        throw badRequest(`Task must be in the '${refineIntakeColumn}' column`);
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
      const status = isTaskLookupMiss(errorWithCode) ? 404 : 500;
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
      const status = isTaskLookupMiss(errorWithCode) ? 404 : 500;
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
        const diffReviewColumns = await resolveReviewColumnsForTask(scopedStore, task.id);
        if (diffReviewColumns.has(task.column) && !task.sessionFile) {
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
      const status = isTaskLookupMiss(errorWithCode) ? 404 : 500;
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
      const status = isTaskLookupMiss(errorWithCode) ? 404
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
      const status = isTaskLookupMiss(errorWithCode) ? 404
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
      const status = isTaskLookupMiss(errorWithCode) ? 404 : 500;
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
      const status = isTaskLookupMiss(errorWithCode) ? 404 : 500;
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

      const { content, author, metadata, expectedRevision, expectedContentHash } = req.body;

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

      try {
        validateTaskDocumentPreconditions({ expectedRevision, expectedContentHash });
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : String(error));
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
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
        ...(expectedContentHash !== undefined ? { expectedContentHash } : {}),
      });

      // Return 201 for new documents (revision === 1), 200 for updates
      const status = document.revision === 1 ? 201 : 200;
      res.status(status).json(document);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof TaskDocumentPreconditionFailedError) {
        throw new ApiError(409, err.message, { ...err.toDetails() });
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = isTaskLookupMiss(errorWithCode) ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  /**
   * FNXC:ArchivedTaskDocumentPublication 2026-07-20-15:36:
   * Archived corrections are an operator-only daemon API, not an ordinary editor or agent write. The server-level bearer middleware authenticates requests when daemon auth is active; this route additionally fails closed when Fusion was launched with `--no-auth` or without a daemon token. Only the additive contract is accepted, and conflict details expose hashes/revisions but never document, reason, or credential bytes.
   */
  router.post("/tasks/:id/documents/:key/archived-publications", async (req, res) => {
    if (!isDaemonAuthActive(options)) {
      throw new ApiError(403, "Archived document publication requires active daemon bearer authentication");
    }
    try {
      if (!DOCUMENT_KEY_REGEX.test(req.params.key)) {
        throw badRequest("Invalid document key. Must be 1-64 alphanumeric characters, hyphens, or underscores.");
      }
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw badRequest("request body must be an object");
      }
      const allowedFields = new Set(["appendContent", "expectedRevision", "expectedContentHash", "author", "reason"]);
      const unknownFields = Object.keys(body).filter((field) => !allowedFields.has(field));
      if (unknownFields.length > 0) {
        throw badRequest(`Unknown archived publication field: ${unknownFields[0]}`);
      }
      if (typeof body.appendContent === "string" && body.appendContent.length > 100000) {
        throw badRequest("appendContent must be between 1 and 100000 characters");
      }
      if (typeof body.author === "string" && body.author.length > 200) {
        throw badRequest("author must be at most 200 characters");
      }
      if (typeof body.reason === "string" && body.reason.length > 2000) {
        throw badRequest("reason must be at most 2000 characters");
      }
      const publication = {
        appendContent: body.appendContent,
        expectedRevision: body.expectedRevision,
        expectedContentHash: body.expectedContentHash,
        author: body.author,
        reason: body.reason,
      };
      try {
        validateArchivedTaskDocumentAddition(publication);
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : String(error));
      }
      const { store: scopedStore } = await getProjectContext(req);
      const result = await scopedStore.publishArchivedTaskDocumentAddition(req.params.id, {
        key: req.params.key,
        appendContent: publication.appendContent,
        expectedRevision: publication.expectedRevision,
        expectedContentHash: publication.expectedContentHash,
        author: publication.author.trim(),
        reason: publication.reason.trim(),
      });
      res.status(201).json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (err instanceof TaskDocumentPreconditionFailedError) {
        throw new ApiError(409, err.message, { ...err.toDetails() });
      }
      if (err instanceof ArchivedTaskDocumentPublicationRejectedError) {
        const status = err.reason === "parent-not-found" || err.reason === "document-not-found" ? 404 : 409;
        throw new ApiError(status, err.message, { ...err.toDetails() });
      }
      throw new ApiError(500, "Archived document publication failed");
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
   * FNXC:NativeStructureEmbed 2026-07-16-12:00:
   * Native-structure consumers need a single project-scoped read endpoint. Unavailable targets
   * deliberately return HTTP 200 with a typed payload so chat and mail render a placeholder;
   * unsupported kinds are malformed requests and remain HTTP 400.
   */
  router.get("/native-structures/:kind/:id/preview", async (req, res) => {
    try {
      const { kind, id } = req.params;
      if (kind !== "mission" && kind !== "milestone" && kind !== "research-finding" && kind !== "eval-result" && kind !== "goal" && kind !== "roadmap-item") {
        throw badRequest("kind must be one of: mission, milestone, research-finding, eval-result, goal, roadmap-item");
      }
      if (!id.trim()) throw badRequest("id must be non-empty");
      const { store: scopedStore } = await getProjectContext(req);
      const preview = await resolveNativeStructurePreview(scopedStore, { kind, id });
      res.json(preview);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(500, err instanceof Error ? err.message : String(err));
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

      /*
      FNXC:ArtifactRegistry 2026-07-11-10:20:
      Video (and audio) playback requires HTTP byte-range serving: <video> seeking issues Range
      requests, and Safari refuses to play media at all from a server that ignores them. Serve
      single-range requests with 206 + Content-Range, advertise Accept-Ranges on full responses,
      and answer unsatisfiable ranges with 416 so players fail cleanly instead of hanging.
      */
      let fileSize: number;
      try {
        // FNXC:ArtifactRegistry 2026-07-10-00:00: use async stat so media/range requests never block the event loop.
        fileSize = (await stat(mediaPath)).size;
      } catch {
        throw notFound("Artifact media not found");
      }

      const mimeType = artifact.mimeType ?? "application/octet-stream";
      const rangeHeader = req.headers.range;
      res.setHeader("Accept-Ranges", "bytes");

      let start = 0;
      let end = fileSize - 1;
      let status = 200;
      if (typeof rangeHeader === "string") {
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
        if (match && (match[1] !== "" || match[2] !== "")) {
          if (match[1] === "") {
            // suffix range: last N bytes
            const suffixLength = Number(match[2]);
            start = Math.max(0, fileSize - suffixLength);
          } else {
            start = Number(match[1]);
            if (match[2] !== "") {
              end = Math.min(Number(match[2]), fileSize - 1);
            }
          }
          if (start >= fileSize || start > end) {
            res.status(416).setHeader("Content-Range", `bytes */${fileSize}`);
            res.end();
            return;
          }
          status = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
        }
      }

      const stream = createReadStream(mediaPath, status === 206 ? { start, end } : undefined);
      stream.on("error", () => {
        if (!res.headersSent) {
          res.status(404).json({ error: "Artifact media not found" });
        } else {
          res.end();
        }
      });
      res.status(status);
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Length", end - start + 1);
      stream.pipe(res);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(500, err instanceof Error ? err.message : String(err));
    }
  });

  /*
  FNXC:ArtifactRegistry 2026-07-10-15:20:
  The Artifacts view opens documents in a full viewer with edit mode, so it needs a single-artifact
  read that INCLUDES inline content (listArtifacts intentionally strips content for lightness) and a
  PATCH that persists title/description/content edits for any inline-content doc. Binary artifacts
  reject content edits in the store layer.
  */
  router.get("/artifacts/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const artifact = await scopedStore.getArtifact(req.params.id);
      if (!artifact) {
        throw notFound("Artifact not found");
      }
      res.json(artifact);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(500, err instanceof Error ? err.message : String(err));
    }
  });

  router.patch("/artifacts/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updates: { title?: string; description?: string; content?: string } = {};

      if (body.title !== undefined) {
        if (typeof body.title !== "string" || body.title.trim().length === 0) {
          throw badRequest("title must be a non-empty string");
        }
        updates.title = body.title;
      }
      if (body.description !== undefined) {
        if (typeof body.description !== "string") {
          throw badRequest("description must be a string");
        }
        updates.description = body.description;
      }
      if (body.content !== undefined) {
        if (typeof body.content !== "string") {
          throw badRequest("content must be a string");
        }
        updates.content = body.content;
      }
      if (Object.keys(updates).length === 0) {
        throw badRequest("Provide at least one of title, description, or content");
      }

      const artifact = await scopedStore.updateArtifact(req.params.id, updates);
      res.json(artifact);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        throw notFound("Artifact not found");
      }
      if (message.includes("read-only") || message.includes("not editable")) {
        throw badRequest(message);
      }
      throw new ApiError(500, message);
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
      const artifactReviewColumns = await resolveReviewColumnsForTask(scopedStore, task.id);
      if (artifactReviewColumns.has(task.column) && !task.sessionFile) {
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
      const status = isTaskLookupMiss(errorWithCode) ? 404 : 500;
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

      /*
      FNXC:WorkflowColumns 2026-07-19-11:10 (U12 review):
      The in-place-reset early return must key on the workflow-resolved intake target, not only
      the literal "triage". On a custom board whose intake column isn't "triage" (e.g. "backlog"),
      a task already sitting at intake would otherwise fall through to
      `canTransition = task.column !== respecifyTarget` === false and be rejected — permanently
      blocking spec revision in exactly the column where respecify belongs. The literal "triage"
      check is kept alongside so legacy behavior stays byte-identical even if a custom workflow
      declares a non-intake column literally named "triage".
      */
      const respecifyTarget = await resolveIntakeColumnForTask(scopedStore, task.id);

      // If task is already at its workflow's intake column, skip the transition
      // check and moveTask. Just reset for replanning in place.
      /*
      FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
      `respecifyTarget` IS the resolved intake column (`resolveIntakeColumnForTask`), so the
      `=== "triage"` disjunct only ever fired for a workflow whose intake is literally
      triage — which that same call already returns. Redundant before the merge, dead after.
      */
      if (task.column === respecifyTarget) {
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
      /*
      FNXC:WorkflowColumns 2026-07-19-02:40 (U12 / R2):
      `VALID_TRANSITIONS` is keyed by the closed legacy enum, so `isColumn(task.column)` was false
      for every workflow-defined column and spec revision was unreachable on a custom board —
      rejected with "Move task to 'todo' or 'in-progress' first", naming columns that workflow may
      not have. Custom workflow columns are always eligible: the already-at-intake case returned
      above, and the workflow itself declares the intake column we send the card to, so there is
      no legacy table to consult. Legacy columns keep the legacy table.
      */
      const canTransition =
        !isColumn(task.column) || VALID_TRANSITIONS[task.column].includes("triage");
      if (!canTransition) {
        throw badRequest(
          `Cannot request spec revision for tasks in '${task.column}' column.`,
        );
      }

      // Log the revision request
      await scopedStore.logEntry(task.id, "AI spec revision requested", feedback);

      // Move to triage for replanning
      const updated = await scopedStore.moveTask(task.id, respecifyTarget);

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
      const status = isTaskLookupMiss(errorWithCode) ? 404
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

      const workflowIr = await resolveWorkflowIrForTask(scopedStore, task.id);
      const currentColumn = "columns" in workflowIr
        ? workflowIr.columns.find((column) => column.id === task.column)
        : undefined;
      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-04:00 (fleet: register-task-workflow-routes.ts):
      FLAGS-FIRST, id only as the fallback. This ORed the legacy id with the resolved trait
      unconditionally, so a column merely NAMED `archived` counted as archived even when its own
      workflow says otherwise — the same inversion pattern found in TaskContextMenu and
      isPreExecutionHoldColumn. When the column resolves, its traits are the answer; the id is only
      for when it does not resolve at all.
      */
      const isArchived = currentColumn != null
        ? resolveColumnFlags(currentColumn).archived === true
        : LEGACY_ARCHIVE_LANES.has(task.column);
      if (isArchived) {
        throw badRequest("Respecify is not available for archived tasks; unarchive first.");
      }

      /*
      FNXC:WorkflowReplan 2026-07-16-12:00:
      Respecify must park work in a planner lane belonging to the task's own workflow:
      triage when declared, otherwise plan-in-place todo, then legacy triage for workflows
      with neither. The legacy fallback is intentionally recovery-rehomed: plain moves reject
      an undeclared triage target as unknown-column (and reject non-adjacent sources), which
      previously stranded no-triage workflows before their needs-replan status was written.
      Archived cards are rejected above rather than resurrected into a planner lane.
      */
      const replanColumn = workflowHasColumn(workflowIr, "triage")
        ? "triage"
        : workflowHasColumn(workflowIr, "todo")
          ? "todo"
          : "triage";

      await scopedStore.logEntry(task.id, "Specification rebuild requested by user");
      await clearRebuiltSpecWorkflowPins(scopedStore, task.id);

      if (task.column !== replanColumn) {
        await scopedStore.moveTask(task.id, replanColumn, {
          moveSource: "user",
          recoveryRehome: true,
        });
      }

      // Remove the existing spec so rebuilds produce a fresh PROMPT.md instead
      // of asking triage to revise whatever was already on disk.
      const { rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
      await rm(promptPath, { force: true });

      // Update status to indicate needs replanning
      await scopedStore.updateTask(task.id, { status: "needs-replan" });

      /*
      FNXC:WorkflowReplan 2026-07-16-12:00:
      Respecify responses must re-read the persisted task after setting needs-replan so
      planner-lane-in-place requests, including legacy triage, never return stale status.
      */
      const updated = await scopedStore.getTask(task.id);
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = isTaskLookupMiss(errorWithCode) ? 404
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

  /**
   * FNXC:TaskStateReconciliation 2026-07-29-11:40:
   * Checklist repair must use the live project-scoped store, map missing tasks to 404, reject out-of-range indices, and report 409 when lifecycle ordering rejects the requested transition instead of returning a false-success 200.
   */
  router.patch("/tasks/:id/steps/:stepIndex", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const stepIndex = Number(req.params.stepIndex);
      const validStatuses = ["pending", "in-progress", "done", "skipped"] as const;
      const status = req.body?.status;

      if (!Number.isInteger(stepIndex) || stepIndex < 0) {
        throw badRequest("stepIndex must be a non-negative integer");
      }
      if (!validStatuses.includes(status)) {
        throw badRequest(`status must be one of: ${validStatuses.join(", ")}`);
      }

      const task = await scopedStore.getTask(req.params.id);
      if (stepIndex >= (task.steps?.length ?? 0)) {
        throw badRequest(`stepIndex ${stepIndex} is out of range`);
      }

      const updated = await scopedStore.updateStep(req.params.id, stepIndex, status);
      if (updated.steps?.[stepIndex]?.status !== status) {
        throw conflict(`Step ${stepIndex} transition to ${status} was rejected`);
      }
      res.json(updated);
    } catch (err: unknown) {
      rethrowTaskApiError(err, req.params.id);
    }
  });

  /**
   * FNXC:TaskStateReconciliation 2026-07-29-11:40:
   * Wedge resolution is compare-and-set against the episode the operator observed. A concurrent replacement episode must remain active rather than being cleared by a stale request from another dashboard process.
   */
  router.post("/tasks/:id/wedge/resolve", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { id } = req.params;
      const episodeId = req.body?.episodeId;
      if (typeof episodeId !== "string" || episodeId.length === 0) {
        throw badRequest("episodeId must be a non-empty string");
      }

      const result = await scopedStore.resolveTaskWedgeNotificationEpisode(id, episodeId);
      if (!result.resolved) {
        throw conflict(`Wedge episode ${episodeId} is no longer active`);
      }
      res.json(result.task);
    } catch (err: unknown) {
      rethrowTaskApiError(err, req.params.id);
    }
  });

  // Update task
  router.patch("/tasks/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { title, description, prompt, priority, dependencies, enabledWorkflowSteps, modelProvider, modelId, validatorModelProvider, validatorModelId, planningModelProvider, planningModelId, mergerModelProvider, mergerModelId, thinkingLevel, validatorThinkingLevel, planningThinkingLevel, mergerThinkingLevel, assigneeUserId, reviewLevel, executionMode, sourceIssue, nodeId, branch, baseBranch, githubTracking, gitlabTracking, noCommitsExpected, autoMerge, overlapBlockedBy, status, dismissNearDuplicate, sessionAdvisorEnabled } = req.body;
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
      const validatedMergerModelProvider = validateModelField(mergerModelProvider, "mergerModelProvider");
      const validatedMergerModelId = validateModelField(mergerModelId, "mergerModelId");
      const validatedAssigneeUserId = validateModelField(assigneeUserId, "assigneeUserId");

      // Validate thinking level fields if provided
      const validThinkingLevels = [...THINKING_LEVELS];
      const validateThinkingLevel = (value: unknown, name: string): void => {
        if (value !== undefined && value !== null && !validThinkingLevels.includes(value as (typeof validThinkingLevels)[number])) {
          throw new Error(`${name} must be one of: ${validThinkingLevels.join(", ")}`);
        }
      };
      validateThinkingLevel(thinkingLevel, "thinkingLevel");
      validateThinkingLevel(validatorThinkingLevel, "validatorThinkingLevel");
      validateThinkingLevel(planningThinkingLevel, "planningThinkingLevel");
      validateThinkingLevel(mergerThinkingLevel, "mergerThinkingLevel");

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
      if (hasBodyField("autoMergeProvenance")) {
        throw badRequest("autoMergeProvenance is server-managed");
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
      // FNXC:SharedBranchMemberHold 2026-08-05-23:55: preserve null through
      // the trusted TaskStore boundary so an operator can clear a prior user hold
      // and return a shared member to inherited/mission policy.
      if (hasBodyField("autoMerge")) updates.autoMerge = autoMerge;
      if (hasBodyField("modelProvider")) updates.modelProvider = validatedModelProvider;
      if (hasBodyField("modelId")) updates.modelId = validatedModelId;
      if (hasBodyField("validatorModelProvider")) updates.validatorModelProvider = validatedValidatorModelProvider;
      if (hasBodyField("validatorModelId")) updates.validatorModelId = validatedValidatorModelId;
      if (hasBodyField("planningModelProvider")) updates.planningModelProvider = validatedPlanningModelProvider;
      if (hasBodyField("planningModelId")) updates.planningModelId = validatedPlanningModelId;
      if (hasBodyField("mergerModelProvider")) updates.mergerModelProvider = validatedMergerModelProvider;
      if (hasBodyField("mergerModelId")) updates.mergerModelId = validatedMergerModelId;
      if (hasBodyField("thinkingLevel")) updates.thinkingLevel = thinkingLevel === null ? null : thinkingLevel;
      if (hasBodyField("validatorThinkingLevel")) updates.validatorThinkingLevel = validatorThinkingLevel === null ? null : validatorThinkingLevel;
      if (hasBodyField("planningThinkingLevel")) updates.planningThinkingLevel = planningThinkingLevel === null ? null : planningThinkingLevel;
      if (hasBodyField("mergerThinkingLevel")) updates.mergerThinkingLevel = mergerThinkingLevel === null ? null : mergerThinkingLevel;
      if (hasBodyField("assigneeUserId")) updates.assigneeUserId = validatedAssigneeUserId;
      if (hasBodyField("reviewLevel")) updates.reviewLevel = reviewLevel;
      if (hasBodyField("executionMode")) updates.executionMode = executionMode === null ? null : executionMode;
      /*
      FNXC:PlannerOversight 2026-07-14-18:11:
      sessionAdvisorEnabled: boolean override, or null to clear back to project default.
      */
      if (hasBodyField("sessionAdvisorEnabled")) {
        if (sessionAdvisorEnabled === null) {
          updates.sessionAdvisorEnabled = null;
        } else if (typeof sessionAdvisorEnabled === "boolean") {
          updates.sessionAdvisorEnabled = sessionAdvisorEnabled;
        } else {
          throw new Error("sessionAdvisorEnabled must be a boolean or null");
        }
      }
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
      const existingTaskForDuplicateDismissal = dismissNearDuplicate === true
        ? await scopedStore.getTask(req.params.id)
        : null;
      let duplicateDismissalResolution: ReturnType<typeof resolveExplicitDuplicateMarker> | null = null;
      if (dismissNearDuplicate === true) {
        const isTriageMarkerDecision = existingTaskForDuplicateDismissal?.sourceMetadata?.duplicateSource === "triage-marker"
          && existingTaskForDuplicateDismissal.pausedReason === "duplicate-decision-required";
        const existingPrompt = existingTaskForDuplicateDismissal
          ? await readFile(join(scopedStore.getRootDir(), ".fusion", "tasks", existingTaskForDuplicateDismissal.id, "PROMPT.md"), "utf-8").catch(() => null)
          : null;
        duplicateDismissalResolution = resolveExplicitDuplicateMarker(existingPrompt, existingTaskForDuplicateDismissal?.title);
        /*
         * FNXC:DuplicateIntake 2026-08-09-02:29:
         * FN-8840 extends an explicit redirect to task titles. Keep must retire the source that
         * created the duplicate-decision hold before releasing it: otherwise a title marker is
         * immediately re-ingested, while deleting PROMPT.md for a title-only redirect loses an
         * operator-authored plan. Same-ID prompt/title markers remain one cleanup operation;
         * conflicts deliberately retain both sources for explicit operator correction.
         */
        if (!duplicateDismissalResolution.conflict && duplicateDismissalResolution.marker) {
          const titleMarker = parseExplicitDuplicateMarker(existingTaskForDuplicateDismissal?.title ?? "");
          if (title === undefined && titleMarker?.canonicalId === duplicateDismissalResolution.marker.canonicalId) {
            updates.title = `Duplicate redirect cleared: ${titleMarker.canonicalId}`;
          }
        }
        /*
         * FNXC:DuplicateIntake 2026-07-16-13:00:
         * Keep resolves Issue #2225's default triage-marker hold by acknowledging the link,
         * clearing only the system pause, and returning to planning without retaining a stub.
         */
        updates.sourceMetadataPatch = { nearDuplicateDismissed: true };
        if (isTriageMarkerDecision) {
          updates.paused = false;
          updates.pausedReason = null;
          updates.status = null;
        }
      }

      /*
      FNXC:WorkflowRouting 2026-07-07-12:00:
      Signature 2 (FN-7641 / NEXT-322 / NEXT-375 / NEXT-340): setting nodeId='end' after a
      human/agent merges the branch tip directly into main (out-of-band, bypassing the merge
      node) must never silently no-op. Pre-validate here so the caller gets an explicit 409
      instead of a 200 that changed nothing when there is no durable merge proof. When proof
      exists (`validation.allowed === true`), `scopedStore.updateTask` below performs the real
      finalize-to-done move itself (shared logic in TaskStore.updateTask / node-override-guard.ts)
      so this route, the CLI task-update tool, and store.updateTask all exhibit identical behavior.
      */
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
      if (
        dismissNearDuplicate === true
        && task.sourceMetadata?.duplicateSource === "triage-marker"
        && duplicateDismissalResolution?.source === "prompt"
      ) {
        const { rm } = await import("node:fs/promises");
        await rm(join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md"), { force: true });
      }

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
      /*
      FNXC:TaskLookup404 2026-07-26-11:45:
      PATCH pre-checks the row with getTask, so an unknown id reaches this catch.
      Classify the miss as 404 BEFORE the 400-vs-500 message classifier — that
      classifier only recognises validation strings, so a missing task fell
      through to 500.
      */
      if (isTaskLookupMiss(err)) {
        rethrowTaskApiError(err, req.params.id);
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("must be a string") || (err instanceof Error ? err.message : String(err)).includes("must be a non-empty string") || (err instanceof Error ? err.message : String(err)).includes("must be a string or null") || (err instanceof Error ? err.message : String(err)).includes("must be an array of strings") || (err instanceof Error ? err.message : String(err)).includes("must be a boolean") || (err instanceof Error ? err.message : String(err)).includes("thinkingLevel must be one of") || (err instanceof Error ? err.message : String(err)).includes("validatorThinkingLevel must be one of") || (err instanceof Error ? err.message : String(err)).includes("planningThinkingLevel must be one of") || (err instanceof Error ? err.message : String(err)).includes("reviewLevel must be an integer") || (err instanceof Error ? err.message : String(err)).includes("executionMode must be one of") || (err instanceof Error ? err.message : String(err)).includes("priority must be one of") || (err instanceof Error ? err.message : String(err)).includes("sourceIssue") || (err instanceof Error ? err.message : String(err)).includes("gitlabTracking") || (err instanceof Error ? err.message : String(err)).includes("status may only be cleared") ? 400 : 500;
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
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
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

        /*
        FNXC:AgentRouting 2026-07-12-12:25:
        Issue #2015: route through the shared bind evaluator so per-agent assignmentPolicy is enforced.
        override=true still bypasses the role check but never assignmentPolicy "none".
        */
        const bindVerdict = evaluateImplementationTaskBind(agent, targetTask, {
          explicitRouting: true,
          executorRoleOverride: override === true,
        });
        if (!bindVerdict.allowed) {
          throw new ApiError(409, bindVerdict.reason);
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
      if (isTaskLookupMiss(err) || (err instanceof Error ? err.message : String(err)).includes("not found")) {
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
      if (isTaskLookupMiss(err) || (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * FNXC:ExternalTaskCheckoutRouting 2026-08-09-22:43:
   * Persist one operator-validated external checkout for both implementation and enforced review. The execution/review route belongs in task source metadata, not the user-defined workflow custom-field schema, and clearing the route must null every persisted routing key.
   */
  router.patch("/tasks/:id/external-checkout", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const checkoutPath = (req.body as { checkoutPath?: unknown } | undefined)?.checkoutPath;
      await scopedStore.getTask(req.params.id);

      if (checkoutPath === null) {
        const task = await scopedStore.updateTask(req.params.id, {
          sourceMetadataPatch: {
            externalExecutionCheckout: null,
            externalExecutionBranch: null,
            externalReviewCheckout: null,
          },
        });
        await scopedStore.logEntry(req.params.id, "External execution/review checkout routing cleared by operator");
        res.json(task);
        return;
      }

      const inspection = await inspectExternalGitCheckout(checkoutPath, { requireClean: true });
      if (!inspection.valid || !inspection.checkoutPath || !inspection.branch) {
        throw badRequest(`Invalid external checkout: ${inspection.reason ?? "unknown error"}`);
      }

      const task = await scopedStore.updateTask(req.params.id, {
        sourceMetadataPatch: {
          externalExecutionCheckout: inspection.checkoutPath,
          externalExecutionBranch: inspection.branch,
          externalReviewCheckout: inspection.checkoutPath,
        },
      });
      await scopedStore.logEntry(
        req.params.id,
        `External execution/review checkout routed to ${inspection.checkoutPath} (${inspection.branch}) by operator`,
      );
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (isTaskLookupMiss(err) || (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
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
      if (isTaskLookupMiss(err) || (err instanceof Error ? err.message : String(err)).includes("not found")) {
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
      if (isTaskLookupMiss(err) || (err instanceof Error ? err.message : String(err)).includes("not found")) {
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
        const requiredCheckNames = resolveRequiredCheckNames(await scopedStore.getSettings());
        const resolveIngestedChecks = createIngestedCheckResolver(scopedStore.getAsyncLayer?.());
        reviewData = await new GitHubClient(options?.githubToken ?? process.env.GITHUB_TOKEN).getPrReviewDetails(owner, repo, task.prInfo.number, { requiredCheckNames, ...(resolveIngestedChecks ? { resolveIngestedChecks } : {}) });
      } else {
        reviewData = await buildDirectTaskReviewData(task, scopedStore);
      }

      res.json(reviewData);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (isTaskLookupMiss(err)) {
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
        const requiredCheckNames = resolveRequiredCheckNames(await scopedStore.getSettings());
        const resolveIngestedChecks = createIngestedCheckResolver(scopedStore.getAsyncLayer?.());
        reviewData = await new GitHubClient(options?.githubToken ?? process.env.GITHUB_TOKEN).getPrReviewDetails(owner, repo, task.prInfo.number, { requiredCheckNames, ...(resolveIngestedChecks ? { resolveIngestedChecks } : {}) });
      } else {
        reviewData = await buildDirectTaskReviewData(task, scopedStore);
      }
      res.json(reviewData);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if (isTaskLookupMiss(err)) {
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
      };

      const selectedItems: SelectedReviewItem[] = Array.isArray(req.body?.selectedItems)
        ? req.body.selectedItems.filter((value: unknown): value is SelectedReviewItem => {
            if (!value || typeof value !== "object") return false;
            const item = value as Record<string, unknown>;
            return typeof item.id === "string" && item.id.trim().length > 0 && typeof item.source === "string";
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
        const requiredCheckNames = resolveRequiredCheckNames(await scopedStore.getSettings());
        const resolveIngestedChecks = createIngestedCheckResolver(scopedStore.getAsyncLayer?.());
        canonicalReviewData = await new GitHubClient(options?.githubToken ?? process.env.GITHUB_TOKEN).getPrReviewDetails(owner, repo, task.prInfo.number, { requiredCheckNames, ...(resolveIngestedChecks ? { resolveIngestedChecks } : {}) });
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
        severity: item.severity,
        resolution: item.resolution,
        threadId: item.threadId,
        htmlUrl: item.url,
        state: item.reviewState ?? undefined,
        isResolved: item.isResolved,
        source: item.sourceMode === "reviewer-agent" ? "reviewer-agent" as const : "github-pr" as const,
        verdict: item.verdict,
        reviewType: item.reviewType,
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
      const expectedSource: "pr-review" | "reviewer-agent" = canonicalReviewData.mode === "pull-request" ? "pr-review" : "reviewer-agent";
      const reviewSourceMismatch = selectedItems.find((item) => canonicalIds.has(item.id) && item.source !== expectedSource);
      if (reviewSourceMismatch) {
        throw badRequest("Selected review source does not match task review mode");
      }
      const hasUnknownSelection = selectedItems.some((item) => !canonicalIds.has(item.id));
      if (hasUnknownSelection) {
        throw badRequest("selectedItems must reference existing review items");
      }

      const canonicalById = new Map(reviewState.items.map((item) => [item.id, item] as const));
      const resolvedSelection = selectedItems.find((selected) => {
        const item = canonicalById.get(selected.id);
        return item?.resolution === "resolved-in-review" || item?.resolution === "superseded";
      });
      if (resolvedSelection) {
        throw badRequest("Review items already resolved during review cannot be selected for revision");
      }
      const canonicalSelections = selectedItems.map((selected) => {
        const item = canonicalById.get(selected.id);
        if (!item) throw badRequest("selectedItems must reference existing review items");
        return {
          id: item.id,
          source: expectedSource,
          summary: item.summary ?? item.body.slice(0, 120),
          body: item.body,
          author: item.author.login,
          filePath: item.path,
          lineNumber: item.line,
          severity: item.severity,
          threadId: item.threadId,
          url: item.htmlUrl,
        };
      });

      const modeSummary = `${reviewState.source === "pull-request" ? "pull-request" : "reviewer-agent"} · ${canonicalSelections.length} selected item(s)`;
      const steeringItems = canonicalSelections.map((item, index) => {
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
        ...canonicalSelections.map((item) => {
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
              severity: item.severity,
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

      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-03:45 (fleet: register-task-workflow-routes.ts):
      Resolved once for this handler and reused by both arms below, so the review/WIP decision cannot
      be made from two different answers.
      */
      const steeringReviewColumns = await resolveReviewColumnsForTask(scopedStore, task.id);
      const steeringWipColumn = await resolveWipColumnForTask(scopedStore, task.id);

      if (steeringReviewColumns.has(task.column)) {
        updatedTask = (await reengageInReviewTaskForUserComment(scopedStore, updatedTask, {
          triggeringCommentType: "steering",
          triggeringCommentIds: steeringCommentId ? [steeringCommentId] : undefined,
          triggerDetail: "review-address",
        })).task;
      } else {
        const hasActiveSession = Boolean(updatedTask.sessionFile);
        if (steeringCommentId && updatedTask.column === steeringWipColumn && updatedTask.assignedAgentId && !hasActiveSession) {
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
      rethrowTaskApiError(err, req.params.id);
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
      const prFeedbackReviewColumns = await resolveReviewColumnsForTask(scopedStore, task.id);
      const prFeedbackWipColumn = await resolveWipColumnForTask(scopedStore, task.id);
      if (!prFeedbackReviewColumns.has(task.column) && task.column !== prFeedbackWipColumn) {
        /* FNXC:WorkflowLifecycleColumns 2026-08-02-05:12: same fix — the operator reads their own columns. */
        const allowed = [...prFeedbackReviewColumns, prFeedbackWipColumn].map((column) => `'${column}'`).join(" or ");
        throw badRequest(`PR feedback can only be addressed for tasks in ${allowed}`);
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

      const reengageReviewColumns = await resolveReviewColumnsForTask(scopedStore, task.id);
      if (reengageReviewColumns.has(task.column)) {
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
        const prFeedbackColumn = await resolveWipColumnForTask(scopedStore, task.id);
        updatedTask = await scopedStore.moveTask(task.id, prFeedbackColumn, { preserveProgress: true });
      }

      const hasActiveSession = Boolean(updatedTask.sessionFile);
      const wakeWipColumn = await resolveWipColumnForTask(scopedStore, updatedTask.id);
      if (updatedTask.column === wakeWipColumn && updatedTask.assignedAgentId && !hasActiveSession) {
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
      rethrowTaskApiError(err, req.params.id);
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
      const unassignColumn = await resolveReboundColumnForTask(scopedStore, req.params.id);
      const task = await scopedStore.moveTask(req.params.id, unassignColumn);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (isTaskLookupMiss(err) || (err instanceof Error ? err.message : String(err)).includes("not found")) {
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
        asyncLayer: scopedStore.getAsyncLayer() ?? undefined,
      });
      await agentStore.init();

      const task = await agentStore.checkoutTask(agentId, req.params.id);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      // FNXC:AgentRouting 2026-07-12-12:25: issue #2015 — checkout is now policy-guarded in AgentStore.checkoutTask; surface the refusal as 409, not 500.
      if (err instanceof Error && err.name === "AgentTaskRoutingPolicyError") {
        throw new ApiError(409, err.message);
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
      rethrowTaskApiError(err, req.params.id);
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
        asyncLayer: scopedStore.getAsyncLayer() ?? undefined,
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
        asyncLayer: scopedStore.getAsyncLayer() ?? undefined,
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
      rethrowTaskApiError(err, req.params.id);
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
      rethrowTaskApiError(err, req.params.id);
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
          /*
          FNXC:TaskDeleteAttribution 2026-07-26-14:30:
          This handler used to hardcode `agentId:"system"` with no caller field, so an operator
          clicking Delete in the dashboard and any script or agent calling the same endpoint wrote
          byte-identical audit rows — which is why a four-delete incident could not be attributed.
          `callerKind` now records what the client SAID it was.

          This is attribution, not authentication: `x-fusion-client` is self-reported and anything
          can send it. A row therefore distinguishes "the client identified itself as the dashboard
          UI" from "nothing identified itself" (`api-unattributed`, the default for absent or
          unrecognized values). Do not gate deletes or permissions on it.
          */
          agentId: "system",
          runId: `synthetic-dashboard-delete-${req.params.id}-${Date.now()}`,
          callerKind: resolveHttpDeleteCallerKind(req.get(FUSION_CLIENT_HEADER)),
        },
      });
      scheduleReleaseExecutionAgentBindings(engine, req.params.id, runtimeLogger);
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

      rethrowTaskApiError(err, req.params.id);
    }
  });


}
