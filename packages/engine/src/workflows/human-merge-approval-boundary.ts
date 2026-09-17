/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
FN-514 — the graph-owned DELIVERY BARRIER.

It sits immediately before the delivery-effecting nodes that already exist (`merge-attempt`,
`branch-group-member-integration`, `branch-group-promotion`, `pr-merge`). It does NOT modify any
persisted IR, does not introduce a second review authority, and never writes a fake
`WorkflowStepResult.pending`: an unauthorized card SUSPENDS on the existing admission-hold marker
family, which parks the resumed continuation `held` with a blocked reason the scheduler and recovery
already understand.

What is deliberately NOT blocked:
  • every planning, execution, verification and review node — the lock stops delivery, never the work
    that must precede it;
  • a `pr-create` node that a PR workflow legitimately runs BEFORE its own review. Blocking that node
    would deadlock the very review the operator is supposed to decide on. Only `pr-merge` is a
    delivery effect in that workflow.

`create-pr` is handled here rather than at the merge door because it is a DISPATCH, not an
authorization: the barrier performs the create-only handoff (idempotently, reconciling an external
effect that may already exist), records the receipt, and then STILL holds — a created PR is not a
merge authorization, so a later merge needs a fresh explicit command on the current candidate.
*/

import {
  collectHumanMergeCorrectionFiles,
  formatHumanMergeCorrectionAmendment,
  parseHumanMergeCorrectionPlan,
  runHumanMergeCorrectionAnalysis,
  type HumanMergeCorrectionAnalysisDeps,
  type HumanMergeCorrectionPlan,
} from "./human-merge-feedback-planner.js";
import { mirrorPlanToProjectDb } from "../plan-artifact-writeback.js";
import {
  buildHumanMergeHoldMarker,
  describeHumanMergeHoldSignature,
  getHumanMergeApprovalBlocker,
  hasCurrentHumanMergeApproval,
  isHumanMergeApprovalEnabled,
  isValidFileScopeEntry,
  locateFileScopeSection,
  resolveHumanMergeDecision,
  resolvePendingHumanMergeRejection,
  type HumanMergeDecisionReceipt,
  type PrEntity,
  type PrEntityCreateInput,
  type Settings,
  type Task,
  type TaskStore,
  type WorkflowIrNode,
} from "@fusion/core";

/** Identity of the PR an entity is created for. Structurally identical to `PrSourceDescriptor`. */
type PrSourceDescriptor = PrEntityCreateInput;

/** Node kinds whose execution publishes a delivery. Everything else runs untouched. */
export const HUMAN_MERGE_DELIVERY_NODE_KINDS: ReadonlySet<string> = new Set([
  "merge-attempt",
  "branch-group-member-integration",
  "branch-group-promotion",
  "pr-merge",
]);

export function isHumanMergeDeliveryNode(node: Pick<WorkflowIrNode, "kind">): boolean {
  return HUMAN_MERGE_DELIVERY_NODE_KINDS.has(node.kind);
}

export type HumanMergeBarrierOutcome =
  | { kind: "proceed" }
  | { kind: "hold"; marker: string; reason: string };

/** Result of the create-only handoff, as reported by the injected provider operations. */
export type HumanMergeCreatePrResult =
  | { state: "created" | "reused"; prNumber: number; prUrl: string; repository?: string }
  | { state: "failed"; error: string }
  /*
  The provider call produced no usable answer (timeout, lost response, ambiguous error). The effect
  may or may not exist externally, so the barrier must RECONCILE before ever calling again and must
  never fall through to a merge.
  */
  | { state: "indeterminate"; error: string };

export type HumanMergeBarrierDeps = {
  store: Pick<TaskStore, "getTask" | "updateHumanMergeDecisionReceipt" | "logEntry">;
  /*
  Create-only PR handoff. Injected, so the engine consumes the CLI's existing
  `createPrNodeGithubOps` composition instead of importing a dashboard/provider surface. It must
  search for an already-open PR of the same repository/head/base before creating one, and must never
  merge, arm native auto-merge, or reuse a CLOSED pull request as a successful handoff.
  */
  createPullRequest?: (task: Task) => Promise<HumanMergeCreatePrResult>;
  /*
  Live delivery evidence for the node about to run. Supplying it makes the barrier compare approved
  content and target against what is actually about to be published.
  */
  resolveEvidence?: (task: Task) => Promise<Parameters<typeof hasCurrentHumanMergeApproval>[1]>;
  /*
  FNXC:HumanMergeApproval 2026-09-17-22:32:
  FN-514 P0 remediation — the graph OWNS rejection processing, so the barrier dispatches it.

  Before this existed, `publishHumanMergeCorrection` had no production caller: a card whose delivery
  the operator refused stayed `rejection.state === "pending"` forever, which blocks every door, makes
  unlocking a no-op, refuses every further command as `request-conflict`, and leaves the UI claiming
  corrections are being prepared while nothing prepares them. Dispatching from HERE keeps the work
  under the graph owner instead of a detached HTTP timer, and the hold below still applies: a
  rejection never becomes a delivery.
  */
  publishCorrection?: (taskId: string) => Promise<unknown>;
};

/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
THE barrier. Called immediately before a delivery node executes, with the FRESHLY READ task so a
decision (or a lock change) that landed during this run is observed rather than a stale snapshot.
*/
export async function evaluateHumanMergeDeliveryBarrier(
  node: Pick<WorkflowIrNode, "id" | "kind">,
  taskSnapshot: Task,
  deps: HumanMergeBarrierDeps,
): Promise<HumanMergeBarrierOutcome> {
  if (!isHumanMergeDeliveryNode(node)) return { kind: "proceed" };

  // Re-read: the decision may have been persisted by an operator while this run was in flight.
  const task = (await deps.store.getTask(taskSnapshot.id).catch(() => undefined)) ?? taskSnapshot;

  const rejection = resolvePendingHumanMergeRejection(task);
  if (rejection) {
    /*
    A `pending` or previously-failed episode has correction work owed and nobody else to run it.
    `publishHumanMergeCorrection` claims the episode atomically, so a concurrent pass that loses the
    claim does nothing; a thrown analysis leaves the episode retryable rather than releasing the door.
    */
    if (rejection.state === "pending" && deps.publishCorrection) {
      await deps.publishCorrection(task.id).catch(() => undefined);
    }
    return {
      kind: "hold",
      /* Stamped with the decision identity observed here, so the hold is re-driven only when it moves. */
      marker: buildHumanMergeHoldMarker("-rejected", describeHumanMergeHoldSignature(
        (await deps.store.getTask(task.id).catch(() => undefined)) ?? task,
      )),
      reason: "delivery refused by the operator; corrections are owed before any delivery",
    };
  }

  if (!isHumanMergeApprovalEnabled(task)) return { kind: "proceed" };

  const decision = resolveHumanMergeDecision(task);

  /*
  A persisted create-pr intent owns this pass. Dispatch it here (idempotently), record the receipt,
  and then hold: the pull request is a handoff, never a merge authorization.
  */
  if (decision?.deliveryAction === "create-pr") {
    const receiptState = decision.receipt?.state;
    if (receiptState === "pending" || receiptState === undefined) {
      await dispatchCreatePullRequest(task, decision.requestId, deps);
    }
    return {
      kind: "hold",
      marker: buildHumanMergeHoldMarker("-pull-request", describeHumanMergeHoldSignature(
        (await deps.store.getTask(task.id).catch(() => undefined)) ?? task,
      )),
      reason: "a pull request was requested instead of a merge; awaiting a further merge command",
    };
  }

  const evidence = (await deps.resolveEvidence?.(task)) ?? {};
  if (hasCurrentHumanMergeApproval(task, evidence)) return { kind: "proceed" };

  return {
    kind: "hold",
    marker: buildHumanMergeHoldMarker("", describeHumanMergeHoldSignature(task)),
    reason: getHumanMergeApprovalBlocker(task, evidence) ?? "awaiting your delivery decision",
  };
}

/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
The create-only handoff. Failure modes are deliberately distinct:

  • `created` / `reused` → a durable receipt with the link. Reuse is the reconciliation path for a
    restart between the provider call and the projection: the same open PR is found and adopted
    rather than duplicated.
  • `failed`            → a retryable receipt on the SAME action. The barrier never switches to a
    merge because a pull request could not be opened.
  • `indeterminate`     → recorded as failed WITH its reason, so the next pass reconciles the
    possible external effect before calling the provider again.

It never arms native auto-merge and never advances toward the merge node.
*/
async function dispatchCreatePullRequest(
  task: Task,
  requestId: string,
  deps: HumanMergeBarrierDeps,
): Promise<void> {
  if (!deps.createPullRequest) {
    await recordReceipt(task, requestId, deps, {
      state: "failed",
      at: new Date().toISOString(),
      error: "pull-request-capability-unavailable",
    });
    return;
  }

  // Mark in-progress first, so a crash mid-call is visibly an attempt rather than an untried intent.
  await recordReceipt(task, requestId, deps, { state: "dispatching", at: new Date().toISOString() });

  let result: HumanMergeCreatePrResult;
  try {
    result = await deps.createPullRequest(task);
  } catch (error) {
    result = { state: "indeterminate", error: error instanceof Error ? error.message : String(error) };
  }

  if (result.state === "failed" || result.state === "indeterminate") {
    await recordReceipt(task, requestId, deps, {
      state: "failed",
      at: new Date().toISOString(),
      error: result.error,
    });
    return;
  }
  {
    await recordReceipt(task, requestId, deps, {
      state: "succeeded",
      at: new Date().toISOString(),
      prNumber: result.prNumber,
      prUrl: result.prUrl,
      ...(result.repository ? { repository: result.repository } : {}),
    });
    await deps.store.logEntry?.(
      task.id,
      result.state === "created" ? "Pull request created for operator handoff" : "Existing pull request reused for operator handoff",
      result.prUrl,
    ).catch(() => undefined);
  }
}

export type HumanMergeCorrectionPublicationDeps = {
  store: Pick<TaskStore, "getTask" | "updateHumanMergeRejectionState" | "appendRemediationSteps" | "logEntry">;
  /** Runs the analysis session and returns the raw model reply. Injected: no product write is given to the model. */
  analyze: (task: Task, rejection: NonNullable<Task["humanMergeApproval"]>["rejection"]) => Promise<string>;
  /** Canonical PROMPT.md publication (authoritative writer + `plan` document mirror). */
  publishAmendment: (task: Task, amendment: string, files: readonly string[]) => Promise<void>;
  /** The existing review → WIP remediation bounce. Never a move to Planning or intake. */
  resumeExecution: (task: Task) => Promise<void>;
};

export type HumanMergeCorrectionPublicationOutcome =
  | { kind: "published"; mode: "fixSteps" | "replan"; appendedCount: number }
  | { kind: "not-applicable" }
  | { kind: "retryable"; reason: string };

/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
Publish the correction for an accepted rejection, in this exact order so every interruption boundary
is closed and resumable without double-appending:

  1. CLAIM the episode (`pending` → `analyzing`), fenced on its requestId. A second worker that loses
     the claim does nothing.
  2. ANALYZE outside any lock or transaction — the model call must never hold one.
  3. PUBLISH the amendment through the canonical prompt path (read-back + `plan` mirror), so a JSONB
     write alone can never be mistaken for a published contract.
  4. APPEND the corrective steps with `remediation.gate: "Human Review"` and the rejection identity,
     preserving every finished step and its report.
  5. MARK the episode `published`, which is what re-opens the delivery door for a NEW decision.
  6. RESUME execution through the existing review → WIP remediation bounce.

Any failure before (5) leaves the refusal durably closed, visible and retryable in review. None of
them authorizes a delivery, and a model that is unavailable or returns invalid output is one of them.
*/
export async function publishHumanMergeCorrection(
  taskId: string,
  deps: HumanMergeCorrectionPublicationDeps,
): Promise<HumanMergeCorrectionPublicationOutcome> {
  const task = await deps.store.getTask(taskId);
  if (!task) return { kind: "not-applicable" };
  const rejection = resolvePendingHumanMergeRejection(task);
  if (!rejection) return { kind: "not-applicable" };
  /* Another worker owns an in-flight analysis; a duplicate dispatch must not produce a second wave. */
  if (rejection.state === "analyzing") return { kind: "not-applicable" };

  const claim = await deps.store.updateHumanMergeRejectionState(taskId, {
    requestId: rejection.requestId,
    patch: { state: "analyzing", attemptCount: (rejection.attemptCount ?? 0) + 1, lastError: undefined },
  });
  if (!claim.applied) return { kind: "not-applicable" };

  let plan: HumanMergeCorrectionPlan;
  try {
    plan = parseHumanMergeCorrectionPlan(await deps.analyze(task, rejection));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    /*
    Back to `pending`, NOT to `published`: an unavailable model or an invalid reply must leave the
    refusal closed and explicitly retryable rather than quietly releasing the delivery.
    */
    await deps.store.updateHumanMergeRejectionState(taskId, {
      requestId: rejection.requestId,
      patch: { state: "pending", lastError: reason },
    }).catch(() => undefined);
    return { kind: "retryable", reason };
  }

  const files = collectHumanMergeCorrectionFiles(plan);
  try {
    await deps.publishAmendment(task, formatHumanMergeCorrectionAmendment(plan, rejection), files);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await deps.store.updateHumanMergeRejectionState(taskId, {
      requestId: rejection.requestId,
      patch: { state: "pending", lastError: reason },
    }).catch(() => undefined);
    return { kind: "retryable", reason };
  }

  const appended = await deps.store.appendRemediationSteps(taskId, plan.steps.map((step) => ({
    name: `Fix: ${step.title}`,
    status: "pending" as const,
    remediation: {
      wave: rejection.remediationGeneration,
      /* A dedicated gate id: this is a HUMAN refusal, never a fabricated Code Review verdict. */
      gate: "Human Review",
      gateStepId: `human-merge-approval:${rejection.requestId}`,
      detail: `${step.detail}\n\nVerification: ${step.verification}`,
      declaredFiles: step.files,
    },
  })) as never);

  await deps.store.updateHumanMergeRejectionState(taskId, {
    requestId: rejection.requestId,
    patch: { state: "published", publishedAt: new Date().toISOString(), analysis: { mode: plan.mode, rationale: plan.rationale, at: new Date().toISOString(), coveredRequirements: plan.coveredRequirements } },
  });
  await deps.store.logEntry?.(
    taskId,
    plan.mode === "replan" ? "Structural correction published after operator rejection" : "Targeted corrections published after operator rejection",
    `${appended.appendedCount} step(s)`,
  ).catch(() => undefined);

  await deps.resumeExecution(task);
  return { kind: "published", mode: plan.mode, appendedCount: appended.appendedCount };
}

/*
FNXC:HumanMergeApproval 2026-09-17-22:32:
FN-514 P0 remediation — the create-only handoff now speaks the REAL `PrNodeDeps` contract.

The first implementation called `createPr({ task, node, source })`. The production callback injected
by `createPrNodeGithubOps` is `({ task, entity, integrationRemote, signal })` and dereferences
`entity.sourceId` on its first line, so every « Créer PR » raised a TypeError, the receipt went
`failed`, and the barrier never retried — the action could not succeed even once. It also never
created a `PrEntity` or a task link, so nothing could later be found for reuse or reconciliation.

This mirrors the `pr-create` node handler exactly (ensure entity → reuse open → force `creating` →
resolve the integration remote → call the provider → persist entity + `prInfo` link), while keeping
the two properties that make it a HANDOFF rather than a delivery:

  • it never touches `mergePr` and never arms native auto-merge;
  • the task link is written with `manual: true`, so the PR stays an operator transfer and the card
    stays in review awaiting a further explicit command.

Failure classification is deliberate: a determinate provider refusal marks the entity `failed` like
the node does, while an INDETERMINATE outcome (timeout/abort/reset) leaves the entity in `creating`
so the next explicit command reconciles the possibly-existing PR instead of blindly opening a second
one, and never falls through to a merge.
*/
type HumanMergeCreatePrOps = {
  getStore?: () => HumanMergeCreatePrStore;
  resolvePrSource?: (task: Task, node: unknown) => Promise<PrSourceDescriptor> | PrSourceDescriptor;
  createPr?: (input: {
    task: Task;
    node: unknown;
    entity: PrEntity;
    integrationRemote?: string;
    signal?: AbortSignal;
  }) => Promise<{ prNumber: number; prUrl: string; headOid?: string }>;
};

type HumanMergeCreatePrStore = {
  getSettings?: () => Promise<{ worktreeRebaseRemote?: string } | undefined>;
  ensurePrEntityForSource?: (input: PrEntityCreateInput) => Promise<PrEntity>;
  getActivePrEntityBySource?: (sourceType: PrEntity["sourceType"], sourceId: string) => Promise<PrEntity | null>;
  updatePrEntity?: (id: string, patch: Record<string, unknown>) => Promise<PrEntity>;
  updatePrInfo?: (id: string, prInfo: Record<string, unknown> | null) => Promise<unknown>;
};

export function buildHumanMergeCreatePrHandoff(
  prNodes: unknown,
  fallbackStore: unknown,
): ((task: Task) => Promise<HumanMergeCreatePrResult>) | undefined {
  const ops = prNodes as HumanMergeCreatePrOps | undefined;
  if (!ops?.resolvePrSource || !ops.createPr) return undefined;
  /* The engine owns the store instance; the CLI-injected slice deliberately carries only callbacks. */
  const store = (ops.getStore?.() ?? fallbackStore) as HumanMergeCreatePrStore | undefined;
  if (!store?.ensurePrEntityForSource || !store.updatePrEntity) return undefined;

  /* A synthetic node identity: the handoff is operator-initiated, not a graph `pr-create` node run. */
  const node = { id: "human-merge-create-pr", kind: "pr-create", column: "in-review" };

  return async (task: Task): Promise<HumanMergeCreatePrResult> => {
    let source: PrSourceDescriptor;
    try {
      source = await ops.resolvePrSource!(task, node);
    } catch (error) {
      return { state: "failed", error: error instanceof Error ? error.message : String(error) };
    }

    let entity: PrEntity;
    try {
      entity = await store.ensurePrEntityForSource!({ ...source, state: source.state ?? "creating" });
    } catch (error) {
      return { state: "failed", error: error instanceof Error ? error.message : String(error) };
    }

    /*
    Reuse / reconcile BEFORE creating: an already-open entity for the same source is the handoff, and
    is also the restart path when a crash landed between the provider call and this projection. A
    closed or merged entity is not a successful handoff and is deliberately not reused here.
    */
    if (entity.state === "open" && entity.prNumber != null && entity.prUrl) {
      await linkManualPullRequest(store, task, entity, entity.prNumber, entity.prUrl);
      return { state: "reused", prNumber: entity.prNumber, prUrl: entity.prUrl, repository: entity.repo };
    }

    let creating = entity;
    if (entity.state !== "creating") {
      try {
        creating = await store.updatePrEntity!(entity.id, { state: "creating", failureReason: null });
      } catch (error) {
        return { state: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    }

    let created: { prNumber: number; prUrl: string; headOid?: string };
    try {
      const integrationRemote = (await store.getSettings?.().catch(() => undefined))?.worktreeRebaseRemote;
      created = await ops.createPr!({
        task,
        node,
        entity: creating,
        ...(integrationRemote ? { integrationRemote } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      /*
      A provider error whose outcome is unknowable (timeout / aborted / network) must NOT be reported
      as a clean failure: an effect may already exist, so the entity stays `creating` and the next
      explicit command reconciles it rather than opening a second pull request.
      */
      const indeterminate = /timeout|abort|ECONNRESET|ETIMEDOUT|socket hang up|EAI_AGAIN/i.test(message);
      if (!indeterminate) {
        await store.updatePrEntity!(creating.id, { state: "failed", failureReason: message }).catch(() => undefined);
      }
      return { state: indeterminate ? "indeterminate" : "failed", error: message };
    }

    try {
      await store.updatePrEntity!(creating.id, {
        state: "open",
        prNumber: created.prNumber,
        prUrl: created.prUrl,
        headOid: created.headOid ?? null,
      });
    } catch {
      /*
      The PR EXISTS. Losing its local projection must not be reported as a failure that invites a
      second create: report the effect honestly and let the reuse/reconcile pass repair the link.
      */
    }
    await linkManualPullRequest(store, task, creating, created.prNumber, created.prUrl);
    return { state: "created", prNumber: created.prNumber, prUrl: created.prUrl, repository: creating.repo };
  };
}

/*
Link the pull request onto the task with `manual: true`, which is what keeps it an operator TRANSFER:
the card stays in review, no merge is implied, and the dashboard renders the link. Repairing the link
on re-entry is intentional — an entity that is already open may still have lost its task projection.
*/
async function linkManualPullRequest(
  store: HumanMergeCreatePrStore,
  task: Task,
  entity: PrEntity,
  prNumber: number,
  prUrl: string,
): Promise<void> {
  await Promise.resolve(store.updatePrInfo?.(task.id, {
    url: prUrl,
    number: prNumber,
    status: "open",
    title: task.title ?? `Task ${task.id}`,
    headBranch: entity.headBranch,
    baseBranch: entity.baseBranch ?? "main",
    commentCount: 0,
    manual: true,
  })).catch(() => undefined);
}

async function recordReceipt(
  task: Task,
  requestId: string,
  deps: HumanMergeBarrierDeps,
  receipt: HumanMergeDecisionReceipt,
): Promise<void> {
  /*
  Fenced on `requestId`: a late response from a superseded attempt must not overwrite a newer
  decision's receipt. A refusal here is expected and non-fatal — the durable decision is what the
  next pass reads.
  */
  await deps.store.updateHumanMergeDecisionReceipt(task.id, { requestId, receipt }).catch(() => undefined);
}

/*
FNXC:HumanMergeApproval 2026-09-17-22:32:
FN-514 P0 remediation — widen the declared `## File Scope` with the files the correction needs.

A structural correction routinely touches files the ORIGINAL plan never declared, and the merger's
squash is scoped to `## File Scope`: publishing corrective steps without widening the section would
strand exactly the work the operator asked for. This mirrors `fn_task_file_scope_add`'s section
surgery rather than inventing a second format, and it only ever ADDS: no declared entry is removed,
so the initial plan's scope evidence stays intact. Invalid or escaping paths were already dropped by
the planner's validator; this re-checks because the section is durable operator-facing contract.
*/
export function widenPromptFileScope(prompt: string, files: readonly string[]): string {
  const section = locateFileScopeSection(prompt);
  if (!section) return prompt;
  const body = prompt.slice(section.sectionStart, section.sectionEnd);
  const existing = new Set((body.match(/`([^`]+)`/g) ?? []).map((token) => token.slice(1, -1)));
  const toAdd = files
    .map((file) => file.trim())
    .filter((file) => file.length > 0 && isValidFileScopeEntry(file) && !existing.has(file));
  if (toAdd.length === 0) return prompt;
  const trimmed = body.replace(/\s+$/, "");
  const insertion = toAdd.map((file) => `- \`${file}\``).join("\n");
  const nextBody = trimmed.length === 0 ? `\n\n${insertion}\n\n` : `${trimmed}\n${insertion}\n\n`;
  return prompt.slice(0, section.sectionStart) + nextBody + prompt.slice(section.sectionEnd);
}

export type HumanMergeCorrectionProductionDeps = {
  store: TaskStore;
  settings: Settings;
  pluginRunner?: unknown;
  /** Read-only working directory for the analysis. Falls back to the project root when the checkout is gone. */
  resolveAnalysisCwd?: (task: Task) => string | undefined;
  /*
  The EXISTING review → WIP remediation bounce (`scheduleWorkflowRerun`). It is deliberately the same
  contained move every other remediation uses: never a move to Planning or intake, never a reset of
  the branch, the worktree or the finished steps.
  */
  scheduleWorkflowRerun: (
    taskId: string,
    worktreePath: string,
    message: string,
    preserveResumeState?: boolean,
    persistWorktreePath?: boolean,
  ) => void;
  signal?: AbortSignal;
  /** Test seam for the analysis session; production resolves the real planner-lane session. */
  createAnalysisSession?: HumanMergeCorrectionAnalysisDeps["createSession"];
};

/*
FNXC:HumanMergeApproval 2026-09-17-22:32:
FN-514 P0 remediation — assemble the PRODUCTION publication dependencies.

This is the concrete `analyze` / `publishAmendment` / `resumeExecution` trio that was missing, so the
graph barrier (and the runtime's hold release that wakes it) can actually process an accepted
rejection instead of leaving it `pending` forever.

`publishAmendment` uses the CANONICAL path — `updateTask({ prompt })`, then a read-back, then the
`plan` document mirror — because a JSONB write alone is not a published contract. The read-back is
fail-closed: if PROMPT.md did not land, the caller keeps the refusal closed and retryable instead of
appending steps against an unpublished plan.
*/
export function buildHumanMergeCorrectionPublicationDeps(
  deps: HumanMergeCorrectionProductionDeps,
): HumanMergeCorrectionPublicationDeps {
  return {
    store: deps.store,
    analyze: async (task, rejection) => {
      if (!rejection) throw new Error("no rejection episode to analyse");
      return runHumanMergeCorrectionAnalysis(task, rejection, {
        store: deps.store,
        settings: deps.settings,
        pluginRunner: deps.pluginRunner,
        cwd: deps.resolveAnalysisCwd?.(task) ?? task.worktree ?? deps.store.getRootDir(),
        ...(deps.signal ? { signal: deps.signal } : {}),
        ...(deps.createAnalysisSession ? { createSession: deps.createAnalysisSession } : {}),
      });
    },
    publishAmendment: async (task, amendment, files) => {
      const base = task.prompt ?? "";
      const next = `${widenPromptFileScope(base, files).replace(/\s+$/, "")}\n${amendment}`;
      await deps.store.updateTask(task.id, { prompt: next });
      /*
      Fail-closed read-back: `project.tasks` has no prompt column, so only re-reading the hydrated
      artifact proves the authoritative PROMPT.md actually carries the amendment.
      */
      const persisted = await deps.store.getTask(task.id).catch(() => undefined);
      if (persisted?.prompt !== next) {
        throw new Error("authoritative PROMPT.md read-back did not match the published correction amendment");
      }
      await mirrorPlanToProjectDb(deps.store, task.id, next, { author: "human-merge-correction" })
        .catch(() => undefined);
    },
    resumeExecution: async (task) => {
      const worktree = task.worktree ?? "";
      deps.scheduleWorkflowRerun(
        task.id,
        worktree,
        `${task.id}: returned to implementation to correct the refused delivery`,
        true,
        /* An absent checkout must not be persisted as the task worktree by the bounce. */
        worktree.length > 0,
      );
    },
  };
}
